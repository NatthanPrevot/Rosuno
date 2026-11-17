// Staff configuration administration (MVP-001 S1).
//
// Provider-neutral and injectable, on the model of the staff verification
// workspace. For every read and every change it establishes afresh, on the
// server: the trusted session subject, a fresh Auth read of that account with
// a confirmed email, the account's one active Rosuno User, and that User's
// one active Staff Profile; then, for the exact scope a read or change
// concerns, the database's own has_staff_capability predicate answered for
// the caller's own session. A Staff Profile alone grants nothing, and no
// capability stands in for another.
//
// What staff see is read through the request's own session under the row
// policies of the configuration-administration migration, so it is never
// wider than those policies allow. Every list is read one page at a time, or
// within an explicit bound that the view reports when it is reached, so
// nothing is ever left out unseen. Every change is one call of one
// operation-specific staff function through the request's own authenticated
// session: the function derives the actor itself, locks and decides the
// caller's authority again, writes the change and its audit event in one
// transaction, and answers a fixed outcome. The checks here only decide what
// staff are offered and told before anything is sent; they never stand in
// for the database's decision. Only the database's own success outcome is
// reported as recorded, a refusal is shown with its reason, and an answer
// that is lost, late, or malformed is never reported as a success. No policy
// value, jurisdiction, launch decision, capability, or question wording is
// defined here: all of it is configuration that staff enter.

import {
  bindEnvironment,
  type EnvironmentBinding,
  type EnvironmentConfiguration,
} from "./environment-binding.ts";
import {
  jsonbText,
  parseDefinition,
  QUESTION_SET_COLUMNS,
} from "./intake-question-set.ts";
import {
  activeUserOf,
  attempt,
  confirmedAccountOf,
  DENIED,
  portFrom,
  rowsOf,
  SIGN_IN_REQUIRED,
  textField,
  UNAVAILABLE,
  type AccountSource,
  type Refusal,
  type RowsResult,
} from "./professional-identity.ts";
import {
  ACCOUNT_STATES,
  isOneOf,
  isTimestamp,
  isUuid,
  readExact,
  readPracticeArea,
  readRows,
  STAFF_STATES,
  type AccountState,
  type StaffState,
} from "./professional-records.ts";
import type { ServerSessionSource } from "./session.ts";
import { STAFF_PROFILE_COLUMNS } from "./staff-verification.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

// The capabilities these surfaces consult. Each is a configuration grant the
// database decides; none implies another.
export const STAFF_CAPABILITIES = Object.freeze([
  "manage_attorney_verification",
  "manage_policy_configuration",
  "manage_jurisdiction_configuration",
  "authorize_jurisdiction_launch",
  "manage_staff_capabilities",
  "manage_intake_configuration",
] as const);
export type StaffCapability = (typeof STAFF_CAPABILITIES)[number];

export const STAFF_SURFACES = Object.freeze([
  "verification",
  "policies",
  "jurisdictions",
  "launch",
  "catalog",
  "capabilities",
  "intake",
] as const);
export type StaffSurface = (typeof STAFF_SURFACES)[number];

export const POLICY_STATUSES = Object.freeze([
  "draft",
  "internal_review",
  "counsel_review",
  "approved",
  "scheduled",
  "active",
  "suspended",
  "retired",
] as const);
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

export const LIFECYCLE_STATES = Object.freeze([
  "unsupported",
  "waitlist",
  "staged",
  "ready",
  "live",
  "restricted",
  "suspended",
] as const);
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

// The lifecycle moves staff are offered, mirroring the database's own
// transition rule. The database decides again on every call.
const POLICY_TRANSITIONS: Readonly<
  Record<PolicyStatus, readonly PolicyStatus[]>
> = Object.freeze({
  draft: Object.freeze(["internal_review"] as const),
  internal_review: Object.freeze(["draft", "counsel_review"] as const),
  counsel_review: Object.freeze([
    "draft",
    "internal_review",
    "approved",
  ] as const),
  approved: Object.freeze(["scheduled", "active", "retired"] as const),
  scheduled: Object.freeze(["active", "retired"] as const),
  active: Object.freeze(["suspended", "retired"] as const),
  suspended: Object.freeze(["active", "retired"] as const),
  retired: Object.freeze([] as const),
});

const DRAFT_FAMILY: readonly PolicyStatus[] = Object.freeze([
  "draft",
  "internal_review",
  "counsel_review",
]);
const ENDABLE: readonly PolicyStatus[] = Object.freeze([
  "approved",
  "scheduled",
  "active",
  "suspended",
]);

// Lists are read one page at a time; a page asks for one row more than it
// shows, so it knows whether another page follows.
export const CONFIGURATION_PAGE_SIZE = 25;
// Lists shown whole (the rows of one record, and the choices a form offers)
// are read within this bound. A view reports when the bound is reached.
export const LIST_BOUND = 200;
// The recent evaluations shown for each launch gate.
export const GATE_HISTORY_BOUND = 10;

// The page a request asks for: a plain decimal page number from 1 to 999999,
// or the first page for anything else.
export function configurationPageOf(value: unknown): number {
  return typeof value === "string" && /^[1-9][0-9]{0,5}$/.test(value)
    ? Number(value)
    : 1;
}

// ---------------------------------------------------------------------------
// Database outcomes
// ---------------------------------------------------------------------------

// Each staff function's own fixed outcomes. An answer outside a function's
// own list is unknown and is never reported either way.
const ENVIRONMENT = ["environment_unrecorded", "environment_mismatch"] as const;
export const CREATE_POLICY_OUTCOMES = Object.freeze([
  "created",
  "invalid",
  "denied",
  "conflict",
  "environment_refused",
  ...ENVIRONMENT,
]);
export const REVISE_POLICY_OUTCOMES = Object.freeze([
  "applied",
  "invalid",
  "not_found",
  "denied",
  "locked",
  "conflict",
  ...ENVIRONMENT,
]);
export const TRANSITION_POLICY_OUTCOMES = Object.freeze([
  "applied",
  "invalid",
  "not_found",
  "denied",
  "locked",
  "conflict",
  "invalid_transition",
  "authority_unverified",
  "effective_period_required",
  ...ENVIRONMENT,
]);
export const END_POLICY_OUTCOMES = Object.freeze([
  "applied",
  "invalid",
  "not_found",
  "denied",
  "locked",
  "already_ended",
  ...ENVIRONMENT,
]);
export const ADD_REFERENCE_OUTCOMES = Object.freeze([
  "created",
  "invalid",
  "not_found",
  "denied",
  "locked",
  ...ENVIRONMENT,
]);
export const DECIDE_REFERENCE_OUTCOMES = Object.freeze([
  "applied",
  "unchanged",
  "invalid",
  "not_found",
  "denied",
  "locked",
  ...ENVIRONMENT,
]);
export const CREATE_JURISDICTION_OUTCOMES = Object.freeze([
  "created",
  "invalid",
  "denied",
  "conflict",
]);
export const LIFECYCLE_OUTCOMES = Object.freeze([
  "applied",
  "unchanged",
  "invalid",
  "denied",
  "not_found",
  "conflict",
  "launch_gates_unmet",
  "launch_authorization_required",
]);
export const CREATE_SERVICE_AREA_OUTCOMES = Object.freeze([
  "created",
  "invalid",
  "denied",
  "conflict",
]);
export const CREATE_PRACTICE_AREA_OUTCOMES = Object.freeze([
  "created",
  "invalid",
  "denied",
  "conflict",
]);
export const PRACTICE_AREA_ACTIVITY_OUTCOMES = Object.freeze([
  "applied",
  "unchanged",
  "invalid",
  "denied",
  "not_found",
]);
export const DEFINE_GATE_OUTCOMES = Object.freeze([
  "created",
  "invalid",
  "denied",
  "not_found",
  "conflict",
]);
export const GATE_EVALUATION_OUTCOMES = Object.freeze([
  "created",
  "invalid",
  "not_found",
  "denied",
]);
export const GRANT_LAUNCH_OUTCOMES = Object.freeze([
  "created",
  "invalid",
  "denied",
  "not_found",
  "already_authorized",
  "launch_gates_unmet",
]);
export const REVOKE_LAUNCH_OUTCOMES = Object.freeze([
  "applied",
  "invalid",
  "not_found",
  "denied",
  "already_revoked",
  "jurisdiction_live",
]);
export const GRANT_CAPABILITY_OUTCOMES = Object.freeze([
  "created",
  "invalid",
  "denied",
  "self_grant_refused",
  "target_not_active_staff",
]);
export const REVOKE_CAPABILITY_OUTCOMES = Object.freeze([
  "applied",
  "invalid",
  "denied",
  "not_found",
  "already_revoked",
]);
export const PUBLISH_QUESTION_SET_OUTCOMES = Object.freeze([
  "published",
  "forbidden",
  "invalid",
  "duplicate_version",
]);

// The refusals staff are told about, each with its own fixed message. Every
// one means nothing was changed.
export const REFUSAL_REASONS = Object.freeze([
  "invalid",
  "conflict",
  "locked",
  "not_found",
  "environment_unrecorded",
  "environment_mismatch",
  "environment_refused",
  "invalid_transition",
  "authority_unverified",
  "effective_period_required",
  "already_ended",
  "launch_gates_unmet",
  "launch_authorization_required",
  "already_authorized",
  "already_revoked",
  "jurisdiction_live",
  "self_grant_refused",
  "target_not_active_staff",
  "duplicate_version",
] as const);
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

// One staff function's answer as the adapter reports it: the function's own
// outcome and, for a creation, the id the database generated; "rejected"
// when the database reported an error inside the call (its transaction
// rolled back, so nothing committed); or "unreadable" when the answer was
// lost, late, or malformed, so the outcome is unknown.
export type CallAnswer =
  | {
      readonly kind: "answer";
      readonly outcome: string;
      readonly value: string | null;
    }
  | { readonly kind: "rejected" }
  | { readonly kind: "unreadable" };

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

// The database predicate's answer for the caller's own session.
export type CapabilityAnswer =
  | { readonly kind: "answer"; readonly granted: boolean }
  | { readonly kind: "unreadable" };

// Request-scoped, unprivileged reads under the database's row policies.
// Paged reads take an offset and a row count; bounded reads take a count.
export type ConfigurationReads = {
  readonly usersOf: (accountId: string) => Promise<RowsResult>;
  readonly staffProfilesOf: (userId: string) => Promise<RowsResult>;
  readonly holdsCapability: (
    capability: StaffCapability,
    jurisdictionId: string | null,
    anyJurisdiction: boolean,
  ) => Promise<CapabilityAnswer>;
  // The database's own environment record (PS-A2 section 5).
  readonly environmentIdentity: () => Promise<RowsResult>;
  readonly policyTypes: (count: number) => Promise<RowsResult>;
  readonly policyVersions: (
    offset: number,
    count: number,
  ) => Promise<RowsResult>;
  readonly policyVersionById: (versionId: string) => Promise<RowsResult>;
  readonly authorityReferencesOf: (
    versionId: string,
    count: number,
  ) => Promise<RowsResult>;
  readonly authorityReferenceById: (referenceId: string) => Promise<RowsResult>;
  readonly jurisdictions: (
    offset: number,
    count: number,
  ) => Promise<RowsResult>;
  readonly jurisdictionById: (jurisdictionId: string) => Promise<RowsResult>;
  readonly serviceAreasOf: (
    jurisdictionId: string,
    count: number,
  ) => Promise<RowsResult>;
  readonly launchGatesOf: (
    jurisdictionId: string,
    count: number,
  ) => Promise<RowsResult>;
  readonly launchGateById: (gateId: string) => Promise<RowsResult>;
  readonly gateEvaluationsOf: (
    gateId: string,
    count: number,
  ) => Promise<RowsResult>;
  readonly launchAuthorizationsOf: (
    jurisdictionId: string,
    count: number,
  ) => Promise<RowsResult>;
  readonly launchAuthorizationById: (
    authorizationId: string,
  ) => Promise<RowsResult>;
  readonly practiceAreas: (
    offset: number,
    count: number,
  ) => Promise<RowsResult>;
  readonly staffMembers: (offset: number, count: number) => Promise<RowsResult>;
  readonly memberUsers: (userIds: readonly string[]) => Promise<RowsResult>;
  readonly grantsOf: (userId: string, count: number) => Promise<RowsResult>;
  readonly capabilityDefinitions: (count: number) => Promise<RowsResult>;
  readonly questionSets: (offset: number, count: number) => Promise<RowsResult>;
};

export type PolicyVersionInput = {
  readonly policyTypeCode: string;
  readonly jurisdictionId: string | null;
  readonly regulatoryModeId: string | null;
  readonly versionLabel: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly supersedesId: string | null;
  readonly developmentOnly: boolean;
};

export type PolicyRevisionInput = {
  readonly versionId: string;
  // The version's updated_at exactly as the page showed it.
  readonly expectedUpdatedAt: string;
  readonly versionLabel: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
};

export type AuthorityReferenceInput = {
  readonly versionId: string;
  readonly authorityType: string;
  readonly citationText: string;
  readonly sourceUri: string | null;
  readonly sourceTitle: string;
  readonly retrievedAt: string;
};

export type ServiceAreaInput = {
  readonly jurisdictionId: string;
  readonly code: string;
  readonly name: string;
  readonly activeFrom: string;
  readonly activeUntil: string | null;
};

// Request-scoped write port: each call is one staff function run for the
// request's own authenticated session. None takes an actor, staff User,
// grant, or scope; the database derives and locks them itself. A target User
// is named only where the operation is about that User (a capability grant).
export type ConfigurationWrites = {
  readonly createPolicyVersion: (
    input: PolicyVersionInput,
  ) => Promise<CallAnswer>;
  readonly revisePolicyDraft: (
    input: PolicyRevisionInput,
  ) => Promise<CallAnswer>;
  readonly transitionPolicyVersion: (
    versionId: string,
    expectedUpdatedAt: string,
    target: PolicyStatus,
  ) => Promise<CallAnswer>;
  readonly endPolicyVersion: (
    versionId: string,
    effectiveUntil: string,
  ) => Promise<CallAnswer>;
  readonly addAuthorityReference: (
    input: AuthorityReferenceInput,
  ) => Promise<CallAnswer>;
  readonly decideAuthorityReference: (
    referenceId: string,
    decision: "verified" | "rejected",
  ) => Promise<CallAnswer>;
  readonly createJurisdiction: (
    code: string,
    name: string,
    regionType: string,
  ) => Promise<CallAnswer>;
  readonly changeJurisdictionLifecycle: (
    jurisdictionId: string,
    expectedUpdatedAt: string,
    target: LifecycleState,
  ) => Promise<CallAnswer>;
  readonly createServiceArea: (input: ServiceAreaInput) => Promise<CallAnswer>;
  readonly createPracticeArea: (
    code: string,
    name: string,
  ) => Promise<CallAnswer>;
  readonly setPracticeAreaActive: (
    practiceAreaId: string,
    active: boolean,
  ) => Promise<CallAnswer>;
  readonly defineLaunchGate: (
    jurisdictionId: string,
    gateCode: string,
    required: boolean,
    description: string | null,
  ) => Promise<CallAnswer>;
  readonly recordLaunchGateEvaluation: (
    gateId: string,
    status: "passed" | "failed",
    evidenceReference: Readonly<Record<string, unknown>> | null,
    reason: string,
  ) => Promise<CallAnswer>;
  readonly grantLaunchAuthorization: (
    jurisdictionId: string,
    reason: string,
  ) => Promise<CallAnswer>;
  readonly revokeLaunchAuthorization: (
    authorizationId: string,
    reason: string,
  ) => Promise<CallAnswer>;
  readonly grantCapability: (
    userId: string,
    capabilityCode: string,
    jurisdictionId: string | null,
    expiresAt: string | null,
  ) => Promise<CallAnswer>;
  readonly revokeCapability: (grantId: string) => Promise<CallAnswer>;
  readonly publishQuestionSet: (
    versionKey: string,
    definition: Readonly<Record<string, unknown>>,
  ) => Promise<CallAnswer>;
};

export type ConfigurationSources = {
  readonly session: ServerSessionSource;
  readonly account: AccountSource;
  readonly reads: () => Promise<ConfigurationReads | null>;
  readonly writes: () => Promise<ConfigurationWrites | null>;
  readonly clock: () => number;
  // The server-side environment configuration compared with the database's
  // own environment record before any policy change (PS-A2 section 6).
  readonly environment: () => EnvironmentConfiguration;
};

// ---------------------------------------------------------------------------
// Records read under the row policies
// ---------------------------------------------------------------------------

export const POLICY_TYPE_COLUMNS = "code, name";
export const CONFIGURATION_POLICY_COLUMNS =
  "id, policy_type_code, jurisdiction_id, regulatory_mode_id, version_label, parameters, status, effective_from, effective_until, approved_at, approved_by_user_id, supersedes_policy_version_id, development_only, created_at, updated_at";
export const AUTHORITY_COLUMNS =
  "id, policy_version_id, authority_type, citation_text, source_uri, source_title, retrieved_at, verified_by_user_id, verification_status";
export const CONFIGURATION_JURISDICTION_COLUMNS =
  "id, code, name, region_type, lifecycle_state, updated_at";
export const SERVICE_AREA_COLUMNS =
  "id, jurisdiction_id, code, name, active_from, active_until";
export const LAUNCH_GATE_COLUMNS =
  "id, jurisdiction_id, gate_code, required, description";
export const GATE_EVALUATION_COLUMNS =
  "id, launch_gate_id, evaluation_status, evaluated_at, evaluated_by_user_id, reason";
export const LAUNCH_AUTHORIZATION_COLUMNS =
  "id, jurisdiction_id, authorized_at, authorized_by_user_id, revoked_at, reason";
export const GRANT_COLUMNS =
  "id, user_id, capability_code, jurisdiction_id, granted_at, expires_at, revoked_at, resource_scope";
export const CAPABILITY_DEFINITION_COLUMNS = "capability_code";
export const MEMBER_USER_COLUMNS = "id, display_name, account_state";
export { QUESTION_SET_COLUMNS };

type Check = (value: unknown) => boolean;

const text: Check = (value) => typeof value === "string" && value.trim() !== "";
const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);
const uuid: Check = isUuid;
const timestamp: Check = isTimestamp;
const flag: Check = (value) => typeof value === "boolean";
const any: Check = () => true;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

// A row read against its exact columns and per-column checks, or null.
function reader<T>(
  columns: string,
  checks: Readonly<Record<string, Check>>,
  build: (get: (key: string) => unknown) => T,
): (row: unknown) => T | null {
  const keys = columns.split(", ");
  return (row) => {
    const fields = readExact(row, keys);
    if (fields === null) {
      return null;
    }
    for (const key of keys) {
      const check = checks[key];
      if (check === undefined || !check(fields.get(key))) {
        return null;
      }
    }
    return Object.freeze(build((key) => fields.get(key)));
  };
}

const str = (value: unknown) => value as string;
const strOrNull = (value: unknown) => value as string | null;

type PolicyTypeRecord = { readonly code: string; readonly name: string };
const readPolicyType = reader<PolicyTypeRecord>(
  POLICY_TYPE_COLUMNS,
  { code: text, name: text },
  (get) => ({ code: str(get("code")), name: str(get("name")) }),
);

type PolicyVersionRecord = {
  readonly id: string;
  readonly typeCode: string;
  readonly jurisdictionId: string | null;
  readonly regulatoryModeId: string | null;
  readonly label: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly status: PolicyStatus;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly approvedAt: string | null;
  readonly approvedBy: string | null;
  readonly supersedesId: string | null;
  readonly developmentOnly: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
};
const readPolicyVersion = reader<PolicyVersionRecord>(
  CONFIGURATION_POLICY_COLUMNS,
  {
    id: uuid,
    policy_type_code: text,
    jurisdiction_id: nullable(uuid),
    regulatory_mode_id: nullable(uuid),
    version_label: text,
    parameters: isPlainObject,
    status: (value) => isOneOf(POLICY_STATUSES, value),
    effective_from: nullable(timestamp),
    effective_until: nullable(timestamp),
    approved_at: nullable(timestamp),
    approved_by_user_id: nullable(uuid),
    supersedes_policy_version_id: nullable(uuid),
    development_only: flag,
    created_at: timestamp,
    updated_at: timestamp,
  },
  (get) => ({
    id: str(get("id")),
    typeCode: str(get("policy_type_code")),
    jurisdictionId: strOrNull(get("jurisdiction_id")),
    regulatoryModeId: strOrNull(get("regulatory_mode_id")),
    label: str(get("version_label")),
    parameters: get("parameters") as Readonly<Record<string, unknown>>,
    status: get("status") as PolicyStatus,
    effectiveFrom: strOrNull(get("effective_from")),
    effectiveUntil: strOrNull(get("effective_until")),
    approvedAt: strOrNull(get("approved_at")),
    approvedBy: strOrNull(get("approved_by_user_id")),
    supersedesId: strOrNull(get("supersedes_policy_version_id")),
    developmentOnly: get("development_only") as boolean,
    createdAt: str(get("created_at")),
    updatedAt: str(get("updated_at")),
  }),
);

type AuthorityRecord = {
  readonly id: string;
  readonly versionId: string;
  readonly authorityType: string;
  readonly citation: string;
  readonly sourceUri: string | null;
  readonly sourceTitle: string;
  readonly retrievedAt: string;
  readonly verifiedBy: string | null;
  readonly status: string;
};
const readAuthority = reader<AuthorityRecord>(
  AUTHORITY_COLUMNS,
  {
    id: uuid,
    policy_version_id: uuid,
    authority_type: text,
    citation_text: text,
    source_uri: nullable(text),
    source_title: text,
    retrieved_at: timestamp,
    verified_by_user_id: nullable(uuid),
    verification_status: text,
  },
  (get) => ({
    id: str(get("id")),
    versionId: str(get("policy_version_id")),
    authorityType: str(get("authority_type")),
    citation: str(get("citation_text")),
    sourceUri: strOrNull(get("source_uri")),
    sourceTitle: str(get("source_title")),
    retrievedAt: str(get("retrieved_at")),
    verifiedBy: strOrNull(get("verified_by_user_id")),
    status: str(get("verification_status")),
  }),
);

type JurisdictionRecord = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly regionType: string;
  readonly state: LifecycleState;
  readonly updatedAt: string;
};
const readJurisdiction = reader<JurisdictionRecord>(
  CONFIGURATION_JURISDICTION_COLUMNS,
  {
    id: uuid,
    code: text,
    name: text,
    region_type: text,
    lifecycle_state: (value) => isOneOf(LIFECYCLE_STATES, value),
    updated_at: timestamp,
  },
  (get) => ({
    id: str(get("id")),
    code: str(get("code")),
    name: str(get("name")),
    regionType: str(get("region_type")),
    state: get("lifecycle_state") as LifecycleState,
    updatedAt: str(get("updated_at")),
  }),
);

type ServiceAreaRecord = {
  readonly id: string;
  readonly jurisdictionId: string;
  readonly code: string;
  readonly name: string;
  readonly activeFrom: string;
  readonly activeUntil: string | null;
};
const readServiceArea = reader<ServiceAreaRecord>(
  SERVICE_AREA_COLUMNS,
  {
    id: uuid,
    jurisdiction_id: uuid,
    code: text,
    name: text,
    active_from: timestamp,
    active_until: nullable(timestamp),
  },
  (get) => ({
    id: str(get("id")),
    jurisdictionId: str(get("jurisdiction_id")),
    code: str(get("code")),
    name: str(get("name")),
    activeFrom: str(get("active_from")),
    activeUntil: strOrNull(get("active_until")),
  }),
);

type GateRecord = {
  readonly id: string;
  readonly jurisdictionId: string;
  readonly code: string;
  readonly required: boolean;
  readonly description: string | null;
};
const readGate = reader<GateRecord>(
  LAUNCH_GATE_COLUMNS,
  {
    id: uuid,
    jurisdiction_id: uuid,
    gate_code: text,
    required: flag,
    description: nullable((value) => typeof value === "string"),
  },
  (get) => ({
    id: str(get("id")),
    jurisdictionId: str(get("jurisdiction_id")),
    code: str(get("gate_code")),
    required: get("required") as boolean,
    description: strOrNull(get("description")),
  }),
);

type EvaluationRecord = {
  readonly id: string;
  readonly gateId: string;
  readonly status: string;
  readonly evaluatedAt: string;
  readonly evaluatedBy: string | null;
  readonly reason: string | null;
};
const readEvaluation = reader<EvaluationRecord>(
  GATE_EVALUATION_COLUMNS,
  {
    id: uuid,
    launch_gate_id: uuid,
    evaluation_status: text,
    evaluated_at: timestamp,
    evaluated_by_user_id: nullable(uuid),
    reason: nullable((value) => typeof value === "string"),
  },
  (get) => ({
    id: str(get("id")),
    gateId: str(get("launch_gate_id")),
    status: str(get("evaluation_status")),
    evaluatedAt: str(get("evaluated_at")),
    evaluatedBy: strOrNull(get("evaluated_by_user_id")),
    reason: strOrNull(get("reason")),
  }),
);

type AuthorizationRecord = {
  readonly id: string;
  readonly jurisdictionId: string;
  readonly authorizedAt: string;
  readonly authorizedBy: string;
  readonly revokedAt: string | null;
  readonly reason: string;
};
const readAuthorization = reader<AuthorizationRecord>(
  LAUNCH_AUTHORIZATION_COLUMNS,
  {
    id: uuid,
    jurisdiction_id: uuid,
    authorized_at: timestamp,
    authorized_by_user_id: uuid,
    revoked_at: nullable(timestamp),
    reason: text,
  },
  (get) => ({
    id: str(get("id")),
    jurisdictionId: str(get("jurisdiction_id")),
    authorizedAt: str(get("authorized_at")),
    authorizedBy: str(get("authorized_by_user_id")),
    revokedAt: strOrNull(get("revoked_at")),
    reason: str(get("reason")),
  }),
);

type StaffRecord = {
  readonly id: string;
  readonly userId: string;
  readonly state: StaffState;
};
const readStaff = reader<StaffRecord>(
  STAFF_PROFILE_COLUMNS,
  {
    id: uuid,
    user_id: uuid,
    staff_state: (value) => isOneOf(STAFF_STATES, value),
  },
  (get) => ({
    id: str(get("id")),
    userId: str(get("user_id")),
    state: get("staff_state") as StaffState,
  }),
);

type MemberUserRecord = {
  readonly id: string;
  readonly displayName: string | null;
  readonly accountState: AccountState;
};
const readMemberUser = reader<MemberUserRecord>(
  MEMBER_USER_COLUMNS,
  {
    id: uuid,
    display_name: nullable((value) => typeof value === "string"),
    account_state: (value) => isOneOf(ACCOUNT_STATES, value),
  },
  (get) => ({
    id: str(get("id")),
    displayName: strOrNull(get("display_name")),
    accountState: get("account_state") as AccountState,
  }),
);

type GrantRecord = {
  readonly id: string;
  readonly userId: string;
  readonly capability: string;
  readonly jurisdictionId: string | null;
  readonly grantedAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly resourceScoped: boolean;
};
const readGrant = reader<GrantRecord>(
  GRANT_COLUMNS,
  {
    id: uuid,
    user_id: uuid,
    capability_code: text,
    jurisdiction_id: nullable(uuid),
    granted_at: timestamp,
    expires_at: nullable(timestamp),
    revoked_at: nullable(timestamp),
    resource_scope: any,
  },
  (get) => ({
    id: str(get("id")),
    userId: str(get("user_id")),
    capability: str(get("capability_code")),
    jurisdictionId: strOrNull(get("jurisdiction_id")),
    grantedAt: str(get("granted_at")),
    expiresAt: strOrNull(get("expires_at")),
    revokedAt: strOrNull(get("revoked_at")),
    resourceScoped: get("resource_scope") !== null,
  }),
);

const readCapabilityDefinition = reader<{ readonly code: string }>(
  CAPABILITY_DEFINITION_COLUMNS,
  { capability_code: text },
  (get) => ({ code: str(get("capability_code")) }),
);

type QuestionSetRecord = {
  readonly id: string;
  readonly versionKey: string;
  readonly publishedAt: string;
  readonly questions: number;
  readonly definition: unknown;
};
function readQuestionSetRow(row: unknown): QuestionSetRecord | null {
  const fields = readExact(row, QUESTION_SET_COLUMNS.split(", "));
  const definition = parseDefinition(fields?.get("definition"));
  const id = fields?.get("id");
  const versionKey = fields?.get("version_key");
  const publishedAt = fields?.get("published_at");
  if (
    fields === null ||
    definition === null ||
    !isUuid(id) ||
    typeof versionKey !== "string" ||
    !/^[a-z][a-z0-9-]{2,63}$/.test(versionKey) ||
    !isTimestamp(publishedAt)
  ) {
    return null;
  }
  return Object.freeze({
    id,
    versionKey,
    publishedAt,
    questions: definition.questions.length,
    definition: fields.get("definition"),
  });
}

// ---------------------------------------------------------------------------
// Shared reading helpers
// ---------------------------------------------------------------------------

function listOf<T>(
  result: unknown,
  read: (row: unknown) => T | null,
): readonly T[] | null {
  const rows = rowsOf(result);
  return rows === null ? null : readRows(rows, read);
}

export type Pager = {
  readonly page: number;
  readonly pageSize: number;
  readonly previousPage: number | null;
  readonly nextPage: number | null;
};

type Paged<T> = { readonly items: readonly T[]; readonly pager: Pager };

// One page of a list. A port that answers more rows than were asked for is
// not trusted: the page is unavailable rather than silently cut.
async function pageOf<T>(
  call: (offset: number, count: number) => Promise<RowsResult>,
  page: number,
  read: (row: unknown) => T | null,
): Promise<Paged<T> | null> {
  const asked = CONFIGURATION_PAGE_SIZE + 1;
  const list = listOf(
    await attempt(() => call((page - 1) * CONFIGURATION_PAGE_SIZE, asked)),
    read,
  );
  if (list === null || list.length > asked) {
    return null;
  }
  return Object.freeze({
    items: Object.freeze(list.slice(0, CONFIGURATION_PAGE_SIZE)),
    pager: Object.freeze({
      page,
      pageSize: CONFIGURATION_PAGE_SIZE,
      previousPage: page > 1 ? page - 1 : null,
      nextPage: list.length > CONFIGURATION_PAGE_SIZE ? page + 1 : null,
    }),
  });
}

type Bounded<T> = { readonly items: readonly T[]; readonly complete: boolean };

// A list shown whole, read within a bound. One row more than the bound is
// asked for, so the view can say when not every row is shown.
async function boundedOf<T>(
  call: (count: number) => Promise<RowsResult>,
  read: (row: unknown) => T | null,
  bound: number = LIST_BOUND,
): Promise<Bounded<T> | null> {
  const list = listOf(await attempt(() => call(bound + 1)), read);
  if (list === null || list.length > bound + 1) {
    return null;
  }
  return Object.freeze({
    items: Object.freeze(list.slice(0, bound)),
    complete: list.length <= bound,
  });
}

// One record by id: the record, null when the caller's session cannot see
// it, or undefined when the read failed or answered something else.
async function oneOf<T extends { readonly id: string }>(
  call: () => Promise<RowsResult>,
  read: (row: unknown) => T | null,
  id: string,
): Promise<T | null | undefined> {
  const list = listOf(await attempt(call), read);
  if (list === null || list.length > 1) {
    return undefined;
  }
  if (list.length === 0) {
    return null;
  }
  return list[0].id === id ? list[0] : undefined;
}

async function jurisdictionsBounded(
  reads: ConfigurationReads,
): Promise<Bounded<JurisdictionRecord> | null> {
  return boundedOf((count) => reads.jurisdictions(0, count), readJurisdiction);
}

function jurisdictionLabel(j: {
  readonly name: string;
  readonly code: string;
}) {
  return `${j.name} (${j.code})`;
}

// ---------------------------------------------------------------------------
// Staff identity and capability
// ---------------------------------------------------------------------------

async function staffOf(
  sources: ConfigurationSources,
  reads: ConfigurationReads,
): Promise<{ readonly userId: string } | Refusal> {
  const account = await confirmedAccountOf(sources.session, sources.account);
  if (!("accountId" in account)) {
    return account;
  }
  const user = await activeUserOf(reads.usersOf, account.accountId);
  if (!("userId" in user)) {
    return user;
  }
  const staff = listOf(
    await attempt(() => reads.staffProfilesOf(user.userId)),
    readStaff,
  );
  if (staff === null || staff.length > 1) {
    return UNAVAILABLE;
  }
  if (staff.length === 0) {
    return DENIED;
  }
  if (staff[0].userId !== user.userId) {
    return UNAVAILABLE;
  }
  return staff[0].state === "active" ? { userId: user.userId } : DENIED;
}

// Whether the caller holds the capability for exactly this scope (null: the
// global, jurisdiction-free scope; any: some grant in any scope), or null
// when unreadable.
async function holds(
  reads: ConfigurationReads,
  capability: StaffCapability,
  jurisdictionId: string | null,
  anyJurisdiction: boolean,
): Promise<boolean | null> {
  const answer = readExact(
    await attempt(() =>
      reads.holdsCapability(capability, jurisdictionId, anyJurisdiction),
    ),
    ["kind", "granted"],
  );
  const granted = answer?.get("granted");
  return answer?.get("kind") === "answer" && typeof granted === "boolean"
    ? granted
    : null;
}

type Context = {
  readonly userId: string;
  readonly reads: ConfigurationReads;
  readonly writes: ConfigurationWrites;
};

// The request's ports and the caller's verified staff identity. A surface
// that offers changes is not offered at all without its write boundary.
async function contextOf(
  sources: ConfigurationSources,
): Promise<Context | Refusal> {
  const reads = await portFrom(sources.reads);
  if (reads === null) {
    return UNAVAILABLE;
  }
  const staff = await staffOf(sources, reads);
  if (!("userId" in staff)) {
    return staff;
  }
  const writes = await portFrom(sources.writes);
  if (writes === null) {
    return UNAVAILABLE;
  }
  return { userId: staff.userId, reads, writes };
}

// Null when the caller holds the capability for exactly this scope;
// otherwise the refusal to show.
async function required(
  reads: ConfigurationReads,
  capability: StaffCapability,
  jurisdictionId: string | null,
): Promise<Refusal | null> {
  const granted = await holds(reads, capability, jurisdictionId, false);
  return granted === null ? UNAVAILABLE : granted ? null : DENIED;
}

async function environmentOf(
  sources: ConfigurationSources,
  reads: ConfigurationReads,
): Promise<EnvironmentBinding> {
  return bindEnvironment(
    rowsOf(await attempt(() => reads.environmentIdentity())),
    sources.environment(),
  );
}

// Who recorded something, as far as the caller needs to know.
export type Who = "you" | "another staff member";
function whoOf(userId: string | null, me: string): Who | null {
  return userId === null
    ? null
    : userId === me
      ? "you"
      : "another staff member";
}

export type Option = { readonly value: string; readonly label: string };

function option(value: string, label: string): Option {
  return Object.freeze({ value, label });
}

// ---------------------------------------------------------------------------
// Staff home
// ---------------------------------------------------------------------------

export type StaffHomeView =
  | Refusal
  | { readonly status: "ready"; readonly surfaces: readonly StaffSurface[] };

// The staff surfaces the caller can use now. A surface is listed only when
// the caller holds a current grant it needs; each surface decides again.
export async function resolveStaffHome(
  sources: ConfigurationSources,
): Promise<StaffHomeView> {
  try {
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const staff = await staffOf(sources, reads);
    if (!("userId" in staff)) {
      return staff;
    }
    const asked: readonly [StaffCapability, boolean][] = [
      ["manage_attorney_verification", true],
      ["manage_policy_configuration", true],
      ["manage_jurisdiction_configuration", true],
      ["authorize_jurisdiction_launch", true],
      ["manage_jurisdiction_configuration", false],
      ["manage_staff_capabilities", false],
      ["manage_intake_configuration", false],
    ];
    const answers: boolean[] = [];
    for (const [capability, anyJurisdiction] of asked) {
      const answer = await holds(reads, capability, null, anyJurisdiction);
      if (answer === null) {
        return UNAVAILABLE;
      }
      answers.push(answer);
    }
    const [
      verify,
      policy,
      jurisdictionAny,
      launch,
      jurisdictionAll,
      staffAdmin,
      intake,
    ] = answers;
    const held: Readonly<Record<StaffSurface, boolean>> = {
      verification: verify,
      policies: policy,
      jurisdictions: jurisdictionAny,
      launch: jurisdictionAny || launch,
      catalog: jurisdictionAll,
      capabilities: staffAdmin,
      intake,
    };
    return Object.freeze({
      status: "ready",
      surfaces: Object.freeze(STAFF_SURFACES.filter((s) => held[s])),
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Policy configuration
// ---------------------------------------------------------------------------

export type PolicyRow = {
  readonly id: string;
  readonly type: string;
  readonly jurisdiction: string;
  readonly label: string;
  readonly status: PolicyStatus;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly developmentOnly: boolean;
};

export type PolicyWorkspaceView =
  | Refusal
  | {
      readonly status: "ready";
      readonly versions: readonly PolicyRow[];
      readonly pager: Pager;
      readonly environment: EnvironmentBinding;
      // Policy changes are refused on an unrecorded or misbound environment.
      readonly canChange: boolean;
      // Development configuration is offered only where the database
      // records a development or staging environment.
      readonly developmentAllowed: boolean;
      readonly policyTypes: readonly Option[];
      readonly policyTypesComplete: boolean;
      // The scopes the caller may create a version for: "global" names the
      // jurisdiction-free scope, offered only to a global grant.
      readonly scopes: readonly Option[];
      readonly scopesComplete: boolean;
    };

const GLOBAL_SCOPE_LABEL = "All jurisdictions (no jurisdiction)";

// The form value naming the jurisdiction-free scope. A scope is always
// chosen explicitly: an empty choice is refused, never read as global.
export const GLOBAL_SCOPE = "global";

function developmentAllowedIn(environment: EnvironmentBinding): boolean {
  return environment === "development" || environment === "staging";
}

function changeAllowedIn(environment: EnvironmentBinding): boolean {
  return environment !== "unrecorded" && environment !== "mismatch";
}

function policyRowOf(
  version: PolicyVersionRecord,
  types: ReadonlyMap<string, string>,
  jurisdictions: ReadonlyMap<string, string>,
): PolicyRow {
  return Object.freeze({
    id: version.id,
    type: types.get(version.typeCode) ?? version.typeCode,
    jurisdiction:
      version.jurisdictionId === null
        ? GLOBAL_SCOPE_LABEL
        : (jurisdictions.get(version.jurisdictionId) ??
          "Jurisdiction not listed"),
    label: version.label,
    status: version.status,
    effectiveFrom: version.effectiveFrom,
    effectiveUntil: version.effectiveUntil,
    developmentOnly: version.developmentOnly,
  });
}

// The policy versions the caller's grant lets it read, newest first, one
// page at a time, and what a new version may be created for.
export async function resolvePolicyWorkspace(
  sources: ConfigurationSources,
  requestedPage?: unknown,
): Promise<PolicyWorkspaceView> {
  try {
    const page = configurationPageOf(requestedPage);
    const context = await contextOf(sources);
    if (!("userId" in context)) {
      return context;
    }
    const { reads } = context;
    const anywhere = await holds(
      reads,
      "manage_policy_configuration",
      null,
      true,
    );
    if (anywhere !== true) {
      return anywhere === null ? UNAVAILABLE : DENIED;
    }
    const global = await holds(
      reads,
      "manage_policy_configuration",
      null,
      false,
    );
    const [types, jurisdictions, versions] = await Promise.all([
      boundedOf((count) => reads.policyTypes(count), readPolicyType),
      jurisdictionsBounded(reads),
      pageOf(
        (offset, count) => reads.policyVersions(offset, count),
        page,
        readPolicyVersion,
      ),
    ]);
    if (
      global === null ||
      types === null ||
      jurisdictions === null ||
      versions === null
    ) {
      return UNAVAILABLE;
    }
    const scopes: Option[] = global
      ? [option(GLOBAL_SCOPE, GLOBAL_SCOPE_LABEL)]
      : [];
    for (const j of jurisdictions.items) {
      const granted = global
        ? true
        : await holds(reads, "manage_policy_configuration", j.id, false);
      if (granted === null) {
        return UNAVAILABLE;
      }
      if (granted) {
        scopes.push(option(j.id, jurisdictionLabel(j)));
      }
    }
    const environment = await environmentOf(sources, reads);
    const typeNames = new Map(types.items.map((t) => [t.code, t.name]));
    const jurisdictionNames = new Map(
      jurisdictions.items.map((j) => [j.id, jurisdictionLabel(j)]),
    );
    return Object.freeze({
      status: "ready",
      versions: Object.freeze(
        versions.items.map((v) => policyRowOf(v, typeNames, jurisdictionNames)),
      ),
      pager: versions.pager,
      environment,
      canChange: changeAllowedIn(environment),
      developmentAllowed: developmentAllowedIn(environment),
      policyTypes: Object.freeze(
        types.items.map((t) => option(t.code, t.name)),
      ),
      policyTypesComplete: types.complete,
      scopes: Object.freeze(scopes),
      scopesComplete: jurisdictions.complete,
    });
  } catch {
    return UNAVAILABLE;
  }
}

export type ReferenceRow = {
  readonly id: string;
  readonly authorityType: string;
  readonly citation: string;
  readonly sourceUri: string | null;
  readonly sourceTitle: string;
  readonly retrievedAt: string;
  readonly status: string;
  readonly verifiedBy: Who | null;
};

export type PolicyVersionView =
  | Refusal
  | {
      readonly status: "ready";
      readonly version: PolicyRow & {
        readonly updatedAt: string;
        readonly createdAt: string;
        readonly approvedAt: string | null;
        readonly approvedBy: Who | null;
        readonly supersedesId: string | null;
        readonly parametersText: string;
      };
      readonly references: readonly ReferenceRow[];
      readonly referencesComplete: boolean;
      readonly hasVerifiedReference: boolean;
      readonly environment: EnvironmentBinding;
      readonly canChange: boolean;
      // Revision and authority references are open only to a draft-family
      // version that is not development configuration.
      readonly draftFamily: boolean;
      readonly transitions: readonly PolicyStatus[];
      readonly canEnd: boolean;
      // A successor draft may supersede this version.
      readonly canSucceed: boolean;
    };

export async function resolvePolicyVersion(
  sources: ConfigurationSources,
  versionIdParam: unknown,
): Promise<PolicyVersionView> {
  try {
    const context = await contextOf(sources);
    if (!("userId" in context)) {
      return context;
    }
    const { reads, userId } = context;
    if (!isUuid(versionIdParam)) {
      return DENIED;
    }
    const version = await oneOf(
      () => reads.policyVersionById(versionIdParam),
      readPolicyVersion,
      versionIdParam,
    );
    if (version === undefined) {
      return UNAVAILABLE;
    }
    // A version the caller's session cannot read looks exactly like one
    // that does not exist.
    if (version === null) {
      return DENIED;
    }
    const refusal = await required(
      reads,
      "manage_policy_configuration",
      version.jurisdictionId,
    );
    if (refusal !== null) {
      return refusal;
    }
    const [types, jurisdictions, references] = await Promise.all([
      boundedOf((count) => reads.policyTypes(count), readPolicyType),
      jurisdictionsBounded(reads),
      boundedOf(
        (count) => reads.authorityReferencesOf(version.id, count),
        readAuthority,
      ),
    ]);
    if (types === null || jurisdictions === null || references === null) {
      return UNAVAILABLE;
    }
    if (references.items.some((r) => r.versionId !== version.id)) {
      return UNAVAILABLE;
    }
    const environment = await environmentOf(sources, reads);
    const row = policyRowOf(
      version,
      new Map(types.items.map((t) => [t.code, t.name])),
      new Map(jurisdictions.items.map((j) => [j.id, jurisdictionLabel(j)])),
    );
    const draftFamily =
      !version.developmentOnly && DRAFT_FAMILY.includes(version.status);
    return Object.freeze({
      status: "ready",
      version: Object.freeze({
        ...row,
        updatedAt: version.updatedAt,
        createdAt: version.createdAt,
        approvedAt: version.approvedAt,
        approvedBy: whoOf(version.approvedBy, userId),
        supersedesId: version.supersedesId,
        parametersText: JSON.stringify(version.parameters, null, 2),
      }),
      references: Object.freeze(
        references.items.map((r) =>
          Object.freeze({
            id: r.id,
            authorityType: r.authorityType,
            citation: r.citation,
            sourceUri: r.sourceUri,
            sourceTitle: r.sourceTitle,
            retrievedAt: r.retrievedAt,
            status: r.status,
            verifiedBy: whoOf(r.verifiedBy, userId),
          }),
        ),
      ),
      referencesComplete: references.complete,
      hasVerifiedReference: references.items.some(
        (r) => r.status === "verified" && r.verifiedBy !== null,
      ),
      environment,
      canChange: changeAllowedIn(environment),
      draftFamily,
      transitions: version.developmentOnly
        ? Object.freeze([])
        : POLICY_TRANSITIONS[version.status],
      canEnd:
        version.effectiveUntil === null &&
        (version.developmentOnly || ENDABLE.includes(version.status)),
      canSucceed: !version.developmentOnly,
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Jurisdictions, service areas, and launch
// ---------------------------------------------------------------------------

export type JurisdictionRow = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly regionType: string;
  readonly state: LifecycleState;
};

function jurisdictionRowOf(j: JurisdictionRecord): JurisdictionRow {
  return Object.freeze({
    id: j.id,
    code: j.code,
    name: j.name,
    regionType: j.regionType,
    state: j.state,
  });
}

export type JurisdictionListView =
  | Refusal
  | {
      readonly status: "ready";
      readonly jurisdictions: readonly JurisdictionRow[];
      readonly pager: Pager;
      // Creating a jurisdiction needs the global grant.
      readonly canCreate: boolean;
    };

async function jurisdictionListOf(
  sources: ConfigurationSources,
  requestedPage: unknown,
  admitted: readonly StaffCapability[],
): Promise<JurisdictionListView> {
  const page = configurationPageOf(requestedPage);
  const context = await contextOf(sources);
  if (!("userId" in context)) {
    return context;
  }
  const { reads } = context;
  let admittedAnywhere = false;
  for (const capability of admitted) {
    const answer = await holds(reads, capability, null, true);
    if (answer === null) {
      return UNAVAILABLE;
    }
    admittedAnywhere ||= answer;
  }
  if (!admittedAnywhere) {
    return DENIED;
  }
  const canCreate = await holds(
    reads,
    "manage_jurisdiction_configuration",
    null,
    false,
  );
  const list = await pageOf(
    (offset, count) => reads.jurisdictions(offset, count),
    page,
    readJurisdiction,
  );
  if (canCreate === null || list === null) {
    return UNAVAILABLE;
  }
  return Object.freeze({
    status: "ready",
    jurisdictions: Object.freeze(list.items.map(jurisdictionRowOf)),
    pager: list.pager,
    canCreate,
  });
}

export async function resolveJurisdictionList(
  sources: ConfigurationSources,
  requestedPage?: unknown,
): Promise<JurisdictionListView> {
  try {
    return await jurisdictionListOf(sources, requestedPage, [
      "manage_jurisdiction_configuration",
    ]);
  } catch {
    return UNAVAILABLE;
  }
}

export async function resolveLaunchList(
  sources: ConfigurationSources,
  requestedPage?: unknown,
): Promise<JurisdictionListView> {
  try {
    return await jurisdictionListOf(sources, requestedPage, [
      "manage_jurisdiction_configuration",
      "authorize_jurisdiction_launch",
    ]);
  } catch {
    return UNAVAILABLE;
  }
}

export type ServiceAreaRow = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly activeFrom: string;
  readonly activeUntil: string | null;
};

export type JurisdictionView =
  | Refusal
  | {
      readonly status: "ready";
      readonly jurisdiction: JurisdictionRow & { readonly updatedAt: string };
      // Every other lifecycle state; the database requires the launch
      // conditions before LIVE.
      readonly targets: readonly LifecycleState[];
      readonly serviceAreas: readonly ServiceAreaRow[];
      readonly serviceAreasComplete: boolean;
    };

async function visibleJurisdictionOf(
  reads: ConfigurationReads,
  jurisdictionIdParam: unknown,
): Promise<JurisdictionRecord | Refusal> {
  if (!isUuid(jurisdictionIdParam)) {
    return DENIED;
  }
  const jurisdiction = await oneOf(
    () => reads.jurisdictionById(jurisdictionIdParam),
    readJurisdiction,
    jurisdictionIdParam,
  );
  return jurisdiction === undefined
    ? UNAVAILABLE
    : jurisdiction === null
      ? DENIED
      : jurisdiction;
}

export async function resolveJurisdiction(
  sources: ConfigurationSources,
  jurisdictionIdParam: unknown,
): Promise<JurisdictionView> {
  try {
    const context = await contextOf(sources);
    if (!("userId" in context)) {
      return context;
    }
    const { reads } = context;
    const jurisdiction = await visibleJurisdictionOf(
      reads,
      jurisdictionIdParam,
    );
    if (!("id" in jurisdiction)) {
      return jurisdiction;
    }
    const refusal = await required(
      reads,
      "manage_jurisdiction_configuration",
      jurisdiction.id,
    );
    if (refusal !== null) {
      return refusal;
    }
    const areas = await boundedOf(
      (count) => reads.serviceAreasOf(jurisdiction.id, count),
      readServiceArea,
    );
    if (
      areas === null ||
      areas.items.some((a) => a.jurisdictionId !== jurisdiction.id)
    ) {
      return UNAVAILABLE;
    }
    return Object.freeze({
      status: "ready",
      jurisdiction: Object.freeze({
        ...jurisdictionRowOf(jurisdiction),
        updatedAt: jurisdiction.updatedAt,
      }),
      targets: Object.freeze(
        LIFECYCLE_STATES.filter((state) => state !== jurisdiction.state),
      ),
      serviceAreas: Object.freeze(
        areas.items.map((a) =>
          Object.freeze({
            id: a.id,
            code: a.code,
            name: a.name,
            activeFrom: a.activeFrom,
            activeUntil: a.activeUntil,
          }),
        ),
      ),
      serviceAreasComplete: areas.complete,
    });
  } catch {
    return UNAVAILABLE;
  }
}

export type EvaluationRow = {
  readonly id: string;
  readonly status: string;
  readonly evaluatedAt: string;
  readonly by: Who | null;
  readonly reason: string | null;
};

export type GateRow = {
  readonly id: string;
  readonly code: string;
  readonly required: boolean;
  readonly description: string | null;
  // Newest first; the first is the gate's latest evaluation.
  readonly evaluations: readonly EvaluationRow[];
  readonly evaluationsComplete: boolean;
};

export type AuthorizationRow = {
  readonly id: string;
  readonly authorizedAt: string;
  readonly by: Who;
  readonly reason: string;
  readonly revokedAt: string | null;
};

export type LaunchView =
  | Refusal
  | {
      readonly status: "ready";
      readonly jurisdiction: JurisdictionRow;
      readonly canManageGates: boolean;
      readonly canAuthorize: boolean;
      readonly gates: readonly GateRow[];
      readonly gatesComplete: boolean;
      readonly requiredGates: number;
      readonly requiredPassed: number;
      readonly authorizations: readonly AuthorizationRow[];
      readonly authorizationsComplete: boolean;
      readonly hasActiveAuthorization: boolean;
    };

export async function resolveLaunch(
  sources: ConfigurationSources,
  jurisdictionIdParam: unknown,
): Promise<LaunchView> {
  try {
    const context = await contextOf(sources);
    if (!("userId" in context)) {
      return context;
    }
    const { reads, userId } = context;
    const jurisdiction = await visibleJurisdictionOf(
      reads,
      jurisdictionIdParam,
    );
    if (!("id" in jurisdiction)) {
      return jurisdiction;
    }
    const canManageGates = await holds(
      reads,
      "manage_jurisdiction_configuration",
      jurisdiction.id,
      false,
    );
    const canAuthorize = await holds(
      reads,
      "authorize_jurisdiction_launch",
      jurisdiction.id,
      false,
    );
    if (canManageGates === null || canAuthorize === null) {
      return UNAVAILABLE;
    }
    if (!canManageGates && !canAuthorize) {
      return DENIED;
    }
    const [gates, authorizations] = await Promise.all([
      boundedOf(
        (count) => reads.launchGatesOf(jurisdiction.id, count),
        readGate,
      ),
      boundedOf(
        (count) => reads.launchAuthorizationsOf(jurisdiction.id, count),
        readAuthorization,
      ),
    ]);
    if (
      gates === null ||
      authorizations === null ||
      gates.items.some((g) => g.jurisdictionId !== jurisdiction.id) ||
      authorizations.items.some((a) => a.jurisdictionId !== jurisdiction.id)
    ) {
      return UNAVAILABLE;
    }
    const rows: GateRow[] = [];
    for (const gate of gates.items) {
      const evaluations = await boundedOf(
        (count) => reads.gateEvaluationsOf(gate.id, count),
        readEvaluation,
        GATE_HISTORY_BOUND,
      );
      if (
        evaluations === null ||
        evaluations.items.some((e) => e.gateId !== gate.id)
      ) {
        return UNAVAILABLE;
      }
      rows.push(
        Object.freeze({
          id: gate.id,
          code: gate.code,
          required: gate.required,
          description: gate.description,
          evaluations: Object.freeze(
            evaluations.items.map((e) =>
              Object.freeze({
                id: e.id,
                status: e.status,
                evaluatedAt: e.evaluatedAt,
                by: whoOf(e.evaluatedBy, userId),
                reason: e.reason,
              }),
            ),
          ),
          evaluationsComplete: evaluations.complete,
        }),
      );
    }
    const requiredRows = rows.filter((g) => g.required);
    return Object.freeze({
      status: "ready",
      jurisdiction: jurisdictionRowOf(jurisdiction),
      canManageGates,
      canAuthorize,
      gates: Object.freeze(rows),
      gatesComplete: gates.complete,
      requiredGates: requiredRows.length,
      requiredPassed: requiredRows.filter(
        (g) => g.evaluations[0]?.status === "passed",
      ).length,
      authorizations: Object.freeze(
        authorizations.items.map((a) =>
          Object.freeze({
            id: a.id,
            authorizedAt: a.authorizedAt,
            by: whoOf(a.authorizedBy, userId) ?? "another staff member",
            reason: a.reason,
            revokedAt: a.revokedAt,
          }),
        ),
      ),
      authorizationsComplete: authorizations.complete,
      hasActiveAuthorization: authorizations.items.some(
        (a) => a.revokedAt === null,
      ),
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Practice-area catalog
// ---------------------------------------------------------------------------

export type PracticeAreaRow = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly active: boolean;
};

export type CatalogView =
  | Refusal
  | {
      readonly status: "ready";
      readonly areas: readonly PracticeAreaRow[];
      readonly pager: Pager;
    };

// The practice-area catalog needs the global jurisdiction-configuration
// grant, exactly as its row policy and its functions do.
export async function resolveCatalog(
  sources: ConfigurationSources,
  requestedPage?: unknown,
): Promise<CatalogView> {
  try {
    const page = configurationPageOf(requestedPage);
    const context = await contextOf(sources);
    if (!("userId" in context)) {
      return context;
    }
    const refusal = await required(
      context.reads,
      "manage_jurisdiction_configuration",
      null,
    );
    if (refusal !== null) {
      return refusal;
    }
    const list = await pageOf(
      (offset, count) => context.reads.practiceAreas(offset, count),
      page,
      readPracticeArea,
    );
    if (list === null) {
      return UNAVAILABLE;
    }
    return Object.freeze({
      status: "ready",
      areas: Object.freeze(
        list.items.map((a) =>
          Object.freeze({
            id: a.id,
            code: a.code,
            name: a.name,
            active: a.active,
          }),
        ),
      ),
      pager: list.pager,
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Capability administration
// ---------------------------------------------------------------------------

export type MemberRow = {
  readonly userId: string;
  readonly name: string;
  readonly accountState: AccountState;
  readonly staffState: StaffState;
  readonly isYou: boolean;
};

export type CapabilityAdministrationView =
  | Refusal
  | {
      readonly status: "ready";
      readonly members: readonly MemberRow[];
      readonly pager: Pager;
    };

function memberRowOf(
  staff: StaffRecord,
  user: MemberUserRecord,
  me: string,
): MemberRow {
  return Object.freeze({
    userId: staff.userId,
    name: user.displayName?.trim() || "Name not provided",
    accountState: user.accountState,
    staffState: staff.state,
    isYou: staff.userId === me,
  });
}

// The Users of the given Staff Profiles, each exactly once, or null.
async function membersOf(
  reads: ConfigurationReads,
  staff: readonly StaffRecord[],
  me: string,
): Promise<readonly MemberRow[] | null> {
  if (staff.length === 0) {
    return Object.freeze([]);
  }
  const ids = staff.map((s) => s.userId);
  const users = listOf(
    await attempt(() => reads.memberUsers(ids)),
    readMemberUser,
  );
  if (users === null || users.length > ids.length) {
    return null;
  }
  const byId = new Map(users.map((u) => [u.id, u]));
  const rows: MemberRow[] = [];
  for (const entry of staff) {
    const user = byId.get(entry.userId);
    if (user === undefined) {
      return null;
    }
    rows.push(memberRowOf(entry, user, me));
  }
  return Object.freeze(rows);
}

// Capability administration needs the global manage_staff_capabilities
// grant, exactly as its row policies and functions do.
export async function resolveCapabilityAdministration(
  sources: ConfigurationSources,
  requestedPage?: unknown,
): Promise<CapabilityAdministrationView> {
  try {
    const page = configurationPageOf(requestedPage);
    const context = await contextOf(sources);
    if (!("userId" in context)) {
      return context;
    }
    const { reads, userId } = context;
    const refusal = await required(reads, "manage_staff_capabilities", null);
    if (refusal !== null) {
      return refusal;
    }
    const staff = await pageOf(
      (offset, count) => reads.staffMembers(offset, count),
      page,
      readStaff,
    );
    if (staff === null) {
      return UNAVAILABLE;
    }
    const members = await membersOf(reads, staff.items, userId);
    if (members === null) {
      return UNAVAILABLE;
    }
    return Object.freeze({ status: "ready", members, pager: staff.pager });
  } catch {
    return UNAVAILABLE;
  }
}

export type GrantState =
  "current" | "scheduled" | "expired" | "revoked" | "resource_scoped";

export type GrantRow = {
  readonly id: string;
  readonly capability: string;
  readonly jurisdiction: string;
  readonly grantedAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly state: GrantState;
};

export type MemberCapabilitiesView =
  | Refusal
  | {
      readonly status: "ready";
      readonly member: MemberRow;
      readonly grants: readonly GrantRow[];
      readonly grantsComplete: boolean;
      // A grant is offered only to an active staff member other than the
      // caller; the database refuses a self-grant and an inactive target.
      readonly canGrant: boolean;
      readonly capabilities: readonly Option[];
      readonly capabilitiesComplete: boolean;
      readonly jurisdictions: readonly Option[];
      readonly jurisdictionsComplete: boolean;
    };

function grantStateOf(grant: GrantRecord, nowMs: number): GrantState {
  if (grant.revokedAt !== null) {
    return "revoked";
  }
  if (grant.resourceScoped) {
    return "resource_scoped";
  }
  if (Date.parse(grant.grantedAt) > nowMs) {
    return "scheduled";
  }
  return grant.expiresAt !== null && Date.parse(grant.expiresAt) <= nowMs
    ? "expired"
    : "current";
}

export async function resolveMemberCapabilities(
  sources: ConfigurationSources,
  memberParam: unknown,
): Promise<MemberCapabilitiesView> {
  try {
    const context = await contextOf(sources);
    if (!("userId" in context)) {
      return context;
    }
    const { reads, userId } = context;
    const refusal = await required(reads, "manage_staff_capabilities", null);
    if (refusal !== null) {
      return refusal;
    }
    if (!isUuid(memberParam)) {
      return DENIED;
    }
    const staff = listOf(
      await attempt(() => reads.staffProfilesOf(memberParam)),
      readStaff,
    );
    if (staff === null || staff.length > 1) {
      return UNAVAILABLE;
    }
    if (staff.length === 0) {
      return DENIED;
    }
    if (staff[0].userId !== memberParam) {
      return UNAVAILABLE;
    }
    const members = await membersOf(reads, staff, userId);
    const [grants, definitions, jurisdictions] = await Promise.all([
      boundedOf((count) => reads.grantsOf(memberParam, count), readGrant),
      boundedOf(
        (count) => reads.capabilityDefinitions(count),
        readCapabilityDefinition,
      ),
      jurisdictionsBounded(reads),
    ]);
    if (
      members === null ||
      grants === null ||
      definitions === null ||
      jurisdictions === null ||
      grants.items.some((g) => g.userId !== memberParam)
    ) {
      return UNAVAILABLE;
    }
    const member = members[0];
    const names = new Map(
      jurisdictions.items.map((j) => [j.id, jurisdictionLabel(j)]),
    );
    const nowMs = sources.clock();
    return Object.freeze({
      status: "ready",
      member,
      grants: Object.freeze(
        grants.items.map((g) =>
          Object.freeze({
            id: g.id,
            capability: g.capability,
            jurisdiction:
              g.jurisdictionId === null
                ? "All jurisdictions"
                : (names.get(g.jurisdictionId) ?? "Jurisdiction not listed"),
            grantedAt: g.grantedAt,
            expiresAt: g.expiresAt,
            revokedAt: g.revokedAt,
            state: grantStateOf(g, nowMs),
          }),
        ),
      ),
      grantsComplete: grants.complete,
      canGrant:
        !member.isYou &&
        member.accountState === "active" &&
        member.staffState === "active",
      capabilities: Object.freeze(
        definitions.items.map((d) => option(d.code, d.code)),
      ),
      capabilitiesComplete: definitions.complete,
      jurisdictions: Object.freeze(
        jurisdictions.items.map((j) => option(j.id, jurisdictionLabel(j))),
      ),
      jurisdictionsComplete: jurisdictions.complete,
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Intake configuration
// ---------------------------------------------------------------------------

export type QuestionSetRow = {
  readonly id: string;
  readonly versionKey: string;
  readonly publishedAt: string;
  readonly questions: number;
};

export type IntakeConfigurationView =
  | Refusal
  | {
      readonly status: "ready";
      readonly versions: readonly QuestionSetRow[];
      readonly pager: Pager;
      // The current (latest published) definition, as a starting point for
      // the next version, or null when none is published.
      readonly currentVersionKey: string | null;
      readonly currentDefinitionText: string | null;
    };

// Publishing intake configuration needs the global
// manage_intake_configuration grant, exactly as its function does.
export async function resolveIntakeConfiguration(
  sources: ConfigurationSources,
  requestedPage?: unknown,
): Promise<IntakeConfigurationView> {
  try {
    const page = configurationPageOf(requestedPage);
    const context = await contextOf(sources);
    if (!("userId" in context)) {
      return context;
    }
    const { reads } = context;
    const refusal = await required(reads, "manage_intake_configuration", null);
    if (refusal !== null) {
      return refusal;
    }
    const [list, current] = await Promise.all([
      pageOf(
        (offset, count) => reads.questionSets(offset, count),
        page,
        readQuestionSetRow,
      ),
      listOf(await attempt(() => reads.questionSets(0, 1)), readQuestionSetRow),
    ]);
    if (list === null || current === null || current.length > 1) {
      return UNAVAILABLE;
    }
    return Object.freeze({
      status: "ready",
      versions: Object.freeze(
        list.items.map((q) =>
          Object.freeze({
            id: q.id,
            versionKey: q.versionKey,
            publishedAt: q.publishedAt,
            questions: q.questions,
          }),
        ),
      ),
      pager: list.pager,
      currentVersionKey: current[0]?.versionKey ?? null,
      currentDefinitionText:
        current.length === 1
          ? JSON.stringify(current[0].definition, null, 2)
          : null,
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

export type FieldErrors = Readonly<Record<string, readonly string[]>>;

// "recorded": the database answered its own success outcome, after the
// change and its audit event committed together. "unchanged": the record was
// already in the requested state; nothing was written. "refused": the
// database (or the same rule applied before sending) refused with the given
// reason; nothing was written. "not-saved": the database reported an error
// inside the call, which rolled back. "unconfirmed": the answer was lost,
// late, or malformed; nothing is claimed either way.
export type ConfigurationActionState =
  | { readonly status: "idle" }
  | { readonly status: "recorded" }
  | { readonly status: "unchanged" }
  | { readonly status: "invalid"; readonly fieldErrors: FieldErrors }
  | { readonly status: "refused"; readonly reason: RefusalReason }
  | { readonly status: "not-saved" }
  | { readonly status: "unconfirmed" }
  | Refusal;

export const INITIAL_CONFIGURATION_STATE: ConfigurationActionState =
  Object.freeze({ status: "idle" });

const RECORDED = Object.freeze({ status: "recorded" } as const);
const UNCHANGED = Object.freeze({ status: "unchanged" } as const);
const NOT_SAVED = Object.freeze({ status: "not-saved" } as const);
const UNCONFIRMED = Object.freeze({ status: "unconfirmed" } as const);

function refused(reason: RefusalReason): ConfigurationActionState {
  return Object.freeze({ status: "refused", reason });
}

function invalid(errors: Record<string, string[]>): ConfigurationActionState {
  const copy: Record<string, readonly string[]> = {};
  for (const [field, messages] of Object.entries(errors)) {
    copy[field] = Object.freeze([...messages]);
  }
  return Object.freeze({ status: "invalid", fieldErrors: Object.freeze(copy) });
}

// The fixed state for one call's answer, read strictly against the
// function's own outcomes. A creation counts only with the id the database
// generated. Anything else is unknown and never reported as a success.
export function stateOfAnswer(
  answer: unknown,
  outcomes: readonly string[],
): ConfigurationActionState {
  const kind = readExact(answer, ["kind"])?.get("kind");
  if (kind === "rejected") {
    return NOT_SAVED;
  }
  const fields = readExact(answer, ["kind", "outcome", "value"]);
  const outcome = fields?.get("outcome");
  const value = fields?.get("value");
  if (
    fields?.get("kind") !== "answer" ||
    typeof outcome !== "string" ||
    !outcomes.includes(outcome)
  ) {
    return UNCONFIRMED;
  }
  if (outcome === "created" || outcome === "published") {
    return isUuid(value) ? RECORDED : UNCONFIRMED;
  }
  if (value !== null) {
    return UNCONFIRMED;
  }
  switch (outcome) {
    case "applied":
      return RECORDED;
    case "unchanged":
      return UNCHANGED;
    case "denied":
    case "forbidden":
      return DENIED;
    default:
      return isOneOf(REFUSAL_REASONS, outcome) ? refused(outcome) : UNCONFIRMED;
  }
}

// Runs one write call. A thrown call is an unknown outcome, never an answer.
async function sent(
  call: () => Promise<CallAnswer>,
  outcomes: readonly string[],
): Promise<ConfigurationActionState> {
  return stateOfAnswer(await attempt(call), outcomes);
}

// --- Form reading ----------------------------------------------------------

type Collected = { readonly errors: Record<string, string[]> };

function newCollected(): Collected {
  return { errors: {} };
}

function hasErrors(collected: Collected): boolean {
  return Object.keys(collected.errors).length > 0;
}

function fail(collected: Collected, field: string, message: string): null {
  (collected.errors[field] ??= []).push(message);
  return null;
}

// One text value of a field; "" when absent; null when repeated or a file.
function single(formData: FormData, name: string): string | null {
  const values = formData.getAll(name);
  if (values.length === 0) {
    return "";
  }
  return values.length === 1 && typeof values[0] === "string"
    ? values[0]
    : null;
}

function requiredText(
  collected: Collected,
  formData: FormData,
  field: string,
  label: string,
  max: number,
): string | null {
  const raw = single(formData, field);
  const value = raw === null ? null : textField(raw, max);
  if (value === null) {
    return fail(
      collected,
      field,
      `${label} must be ${max} characters or fewer, without control characters.`,
    );
  }
  return value === ""
    ? fail(collected, field, `Enter ${label.toLowerCase()}.`)
    : value;
}

// undefined: refused (the error is collected); null: left empty.
function optionalText(
  collected: Collected,
  formData: FormData,
  field: string,
  label: string,
  max: number,
): string | null | undefined {
  const raw = single(formData, field);
  const value = raw === null ? null : textField(raw, max);
  if (value === null) {
    fail(
      collected,
      field,
      `${label} must be ${max} characters or fewer, without control characters.`,
    );
    return undefined;
  }
  return value === "" ? null : value;
}

function codeField(
  collected: Collected,
  formData: FormData,
  field: string,
  label: string,
  pattern: RegExp,
  rule: string,
): string | null {
  const raw = single(formData, field)?.trim() ?? null;
  if (raw === null || !pattern.test(raw)) {
    return fail(collected, field, `${label} ${rule}`);
  }
  return raw;
}

const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

// A YYYY-MM-DDTHH:MM[:SS] value, read as UTC, as epoch milliseconds, or
// null. Seconds are kept, so a stored time shown in a form is sent back
// unchanged.
function dateTimeOf(raw: string): number | null {
  const match = DATE_TIME.exec(raw.trim());
  if (match === null) {
    return null;
  }
  const written = `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? "00"}`;
  const ms = Date.parse(`${written}Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== written
    ? null
    : ms;
}

// undefined: refused (the error is collected); null: left empty.
function instantField(
  collected: Collected,
  formData: FormData,
  field: string,
  label: string,
  isRequired: boolean,
): number | null | undefined {
  const raw = single(formData, field);
  if (raw === "" && !isRequired) {
    return null;
  }
  const ms = raw === null ? null : dateTimeOf(raw);
  if (ms === null) {
    fail(collected, field, `${label} must be a date and time (UTC).`);
    return undefined;
  }
  return ms;
}

function isoOf(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

// The optional end of a period, which must come after its start.
function periodEnd(
  collected: Collected,
  formData: FormData,
  field: string,
  label: string,
  startMs: number | null | undefined,
  startLabel: string,
): number | null | undefined {
  const end = instantField(collected, formData, field, label, false);
  if (typeof end === "number") {
    if (startMs === null) {
      fail(collected, field, `${label} needs ${startLabel.toLowerCase()}.`);
      return undefined;
    }
    if (typeof startMs === "number" && end <= startMs) {
      fail(
        collected,
        field,
        `${label} must be after ${startLabel.toLowerCase()}.`,
      );
      return undefined;
    }
  }
  return end;
}

// The most significant digits a number may have and still be stored
// exactly as entered (an IEEE 754 double keeps 15).
const MAX_SIGNIFICANT_DIGITS = 15;
const MAX_JSON_TEXT = 262144;

// Number literals of valid JSON text, outside strings, in order.
function numberLiterals(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(
    /"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
  )) {
    if (!match[0].startsWith('"')) {
      found.push(match[0]);
    }
  }
  return found;
}

function significantDigits(literal: string): number {
  return literal
    .replace(/^-/, "")
    .replace(/[eE].*$/, "")
    .replace(".", "")
    .replace(/^0+/, "").length;
}

// A JSON object entered by staff, read so that what is sent is exactly what
// was entered: valid JSON, an object at the top, every number finite and
// exact, and within the database's size bound. undefined: refused (the
// error is collected); null: left empty (only when not required).
function jsonObjectField(
  collected: Collected,
  formData: FormData,
  field: string,
  label: string,
  maxBytes: number,
  isRequired: boolean,
): Readonly<Record<string, unknown>> | null | undefined {
  const raw = single(formData, field);
  if (raw === null || raw.length > MAX_JSON_TEXT) {
    fail(collected, field, `${label} is too long.`);
    return undefined;
  }
  if (raw.trim() === "") {
    if (isRequired) {
      fail(collected, field, `Enter ${label.toLowerCase()} as a JSON object.`);
      return undefined;
    }
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(collected, field, `${label} is not valid JSON.`);
    return undefined;
  }
  if (!isPlainObject(value)) {
    fail(collected, field, `${label} must be a JSON object ({ ... }).`);
    return undefined;
  }
  for (const literal of numberLiterals(raw)) {
    if (
      !Number.isFinite(Number(literal)) ||
      significantDigits(literal) > MAX_SIGNIFICANT_DIGITS
    ) {
      fail(
        collected,
        field,
        `${label} holds a number that cannot be stored exactly (at most ${MAX_SIGNIFICANT_DIGITS} significant digits).`,
      );
      return undefined;
    }
  }
  if (new TextEncoder().encode(jsonbText(value)).length > maxBytes) {
    fail(collected, field, `${label} must be ${maxBytes} bytes or fewer.`);
    return undefined;
  }
  return value;
}

// A hidden field naming one record; anything else means the form was not
// one this page rendered.
function idField(formData: FormData, field: string): string | null {
  const value = single(formData, field);
  return isUuid(value) ? value : null;
}

// The record version the page showed, sent back as a concurrency token. The
// database refuses a change when the record has moved on since.
function versionToken(formData: FormData): string | null {
  const value = single(formData, "expected_updated_at");
  return isTimestamp(value) ? value : null;
}

// Each action runs its checks in a fixed order: the submitted form, then the
// caller's verified staff identity, then the exact capability for the
// record's scope, then the one write. It never throws.
async function guarded(
  formData: unknown,
  run: (form: FormData) => Promise<ConfigurationActionState>,
): Promise<ConfigurationActionState> {
  try {
    return formData instanceof FormData ? await run(formData) : UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

// The environment rule for policy changes (PS-A2 section 6): nothing is sent
// on an unrecorded or misbound environment.
function environmentRefusal(
  environment: EnvironmentBinding,
): ConfigurationActionState | null {
  if (environment === "unrecorded") {
    return refused("environment_unrecorded");
  }
  return environment === "mismatch" ? refused("environment_mismatch") : null;
}

const POLICY_TYPE_CODE = /^[a-z][a-z0-9_]{2,63}$/;

// An explicitly chosen scope: null for the jurisdiction-free scope, or one
// jurisdiction id. undefined: refused (the error is collected).
function scopeField(
  collected: Collected,
  formData: FormData,
): string | null | undefined {
  const raw = single(formData, "scope");
  if (raw === GLOBAL_SCOPE) {
    return null;
  }
  if (isUuid(raw)) {
    return raw;
  }
  fail(collected, "scope", "Choose a scope from the list.");
  return undefined;
}

// --- Policy configuration --------------------------------------------------

// Creates a draft policy version, or a development configuration where the
// database records a development or staging environment. A successor names
// the version it supersedes and takes that version's type and scope.
export async function createPolicyVersion(
  sources: ConfigurationSources,
  formData: unknown,
): Promise<ConfigurationActionState> {
  return guarded(formData, async (form) => {
    const supersedesRaw = single(form, "supersedes");
    if (
      supersedesRaw === null ||
      (supersedesRaw !== "" && !isUuid(supersedesRaw))
    ) {
      return UNAVAILABLE;
    }
    const supersedes = supersedesRaw === "" ? null : supersedesRaw;
    const development = single(form, "development_only");
    if (development !== "" && development !== "yes") {
      return UNAVAILABLE;
    }
    const collected = newCollected();
    let typeCode: string | null = null;
    let scope: string | null | undefined = undefined;
    if (supersedes === null) {
      typeCode = codeField(
        collected,
        form,
        "policy_type",
        "Policy type",
        POLICY_TYPE_CODE,
        "must be chosen from the list.",
      );
      scope = scopeField(collected, form);
    }
    const label = requiredText(
      collected,
      form,
      "version_label",
      "Version label",
      80,
    );
    const parameters = jsonObjectField(
      collected,
      form,
      "parameters",
      "Parameters",
      65536,
      true,
    );
    const from = instantField(
      collected,
      form,
      "effective_from",
      "Effective from",
      false,
    );
    const until = periodEnd(
      collected,
      form,
      "effective_until",
      "Effective until",
      from,
      "Effective from",
    );
    const developmentOnly = development === "yes";
    if (developmentOnly && from === null) {
      fail(
        collected,
        "effective_from",
        "A development configuration needs an effective start.",
      );
    }
    if (
      hasErrors(collected) ||
      label === null ||
      parameters === null ||
      parameters === undefined ||
      from === undefined ||
      until === undefined
    ) {
      return invalid(collected.errors);
    }
    const context = await contextOf(sources);
    if (!("userId" in context)) {
      return context;
    }
    const { reads, writes } = context;
    const environment = await environmentOf(sources, reads);
    const environmentRefused = environmentRefusal(environment);
    if (environmentRefused !== null) {
      return environmentRefused;
    }
    if (developmentOnly && !developmentAllowedIn(environment)) {
      return refused("environment_refused");
    }
    let regulatoryModeId: string | null = null;
    if (supersedes !== null) {
      const previous = await oneOf(
        () => reads.policyVersionById(supersedes),
        readPolicyVersion,
        supersedes,
      );
      if (previous === undefined) {
        return UNAVAILABLE;
      }
      if (previous === null) {
        return DENIED;
      }
      typeCode = previous.typeCode;
      scope = previous.jurisdictionId;
      regulatoryModeId = previous.regulatoryModeId;
    }
    if (typeCode === null || scope === undefined) {
      return UNAVAILABLE;
    }
    const refusal = await required(reads, "manage_policy_configuration", scope);
    if (refusal !== null) {
      return refusal;
    }
    const input: PolicyVersionInput = {
      policyTypeCode: typeCode,
      jurisdictionId: scope,
      regulatoryModeId,
      versionLabel: label,
      parameters,
      effectiveFrom: isoOf(from),
      effectiveUntil: isoOf(until),
      supersedesId: supersedes,
      developmentOnly,
    };
    return sent(
      () => writes.createPolicyVersion(input),
      CREATE_POLICY_OUTCOMES,
    );
  });
}

// The policy version a change concerns, read through the caller's own
// session, with the caller's capability for its scope, on a bound
// environment.
async function policyChangeContext(
  sources: ConfigurationSources,
  versionId: string,
  known?: Context,
): Promise<
  | { readonly context: Context; readonly version: PolicyVersionRecord }
  | ConfigurationActionState
> {
  const context = known ?? (await contextOf(sources));
  if (!("userId" in context)) {
    return context;
  }
  const environmentRefused = environmentRefusal(
    await environmentOf(sources, context.reads),
  );
  if (environmentRefused !== null) {
    return environmentRefused;
  }
  const version = await oneOf(
    () => context.reads.policyVersionById(versionId),
    readPolicyVersion,
    versionId,
  );
  if (version === undefined) {
    return UNAVAILABLE;
  }
  if (version === null) {
    return DENIED;
  }
  const refusal = await required(
    context.reads,
    "manage_policy_configuration",
    version.jurisdictionId,
  );
  return refusal ?? { context, version };
}

export async function revisePolicyDraft(
  sources: ConfigurationSources,
  formData: unknown,
): Promise<ConfigurationActionState> {
  return guarded(formData, async (form) => {
    const versionId = idField(form, "version");
    const expected = versionToken(form);
    if (versionId === null || expected === null) {
      return UNAVAILABLE;
    }
    const collected = newCollected();
    const label = requiredText(
      collected,
      form,
      "version_label",
      "Version label",
      80,
    );
    const parameters = jsonObjectField(
      collected,
      form,
      "parameters",
      "Parameters",
      65536,
      true,
    );
    const from = instantField(
      collected,
      form,
      "effective_from",
      "Effective from",
      false,
    );
    const until = periodEnd(
      collected,
      form,
      "effective_until",
      "Effective until",
      from,
      "Effective from",
    );
    if (
      hasErrors(collected) ||
      label === null ||
      parameters === null ||
      parameters === undefined ||
      from === undefined ||
      until === undefined
    ) {
      return invalid(collected.errors);
    }
    const checked = await policyChangeContext(sources, versionId);
    if (!("version" in checked)) {
      return checked;
    }
    const input: PolicyRevisionInput = {
      versionId,
      expectedUpdatedAt: expected,
      versionLabel: label,
      parameters,
      effectiveFrom: isoOf(from),
      effectiveUntil: isoOf(until),
    };
    return sent(
      () => checked.context.writes.revisePolicyDraft(input),
      REVISE_POLICY_OUTCOMES,
    );
  });
}

export async function transitionPolicyVersion(
  sources: ConfigurationSources,
  formData: unknown,
): Promise<ConfigurationActionState> {
  return guarded(formData, async (form) => {
    const versionId = idField(form, "version");
    const expected = versionToken(form);
    const target = single(form, "target_status");
    if (
      versionId === null ||
      expected === null ||
      !isOneOf(POLICY_STATUSES, target)
    ) {
      return UNAVAILABLE;
    }
    const checked = await policyChangeContext(sources, versionId);
    if (!("version" in checked)) {
      return checked;
    }
    return sent(
      () =>
        checked.context.writes.transitionPolicyVersion(
          versionId,
          expected,
          target,
        ),
      TRANSITION_POLICY_OUTCOMES,
    );
  });
}

export async function endPolicyVersion(
  sources: ConfigurationSources,
  formData: unknown,
): Promise<ConfigurationActionState> {
  return guarded(formData, async (form) => {
    const versionId = idField(form, "version");
    if (versionId === null) {
      return UNAVAILABLE;
    }
    const collected = newCollected();
    const until = instantField(
      collected,
      form,
      "effective_until",
      "Effective until",
      true,
    );
    if (typeof until === "number" && until <= sources.clock()) {
      fail(
        collected,
        "effective_until",
        "Effective until must be in the future.",
      );
    }
    if (hasErrors(collected) || typeof until !== "number") {
      return invalid(collected.errors);
    }
    const checked = await policyChangeContext(sources, versionId);
    if (!("version" in checked)) {
      return checked;
    }
    const iso = new Date(until).toISOString();
    return sent(
      () => checked.context.writes.endPolicyVersion(versionId, iso),
      END_POLICY_OUTCOMES,
    );
  });
}

export async function addAuthorityReference(
  sources: ConfigurationSources,
  formData: unknown,
): Promise<ConfigurationActionState> {
  return guarded(formData, async (form) => {
    const versionId = idField(form, "version");
    if (versionId === null) {
      return UNAVAILABLE;
    }
    const collected = newCollected();
    const authorityType = requiredText(
      collected,
      form,
      "authority_type",
      "Authority type",
      80,
    );
    const citation = requiredText(
      collected,
      form,
      "citation_text",
      "Citation",
      1000,
    );
    const sourceUri = optionalText(
      collected,
      form,
      "source_uri",
      "Source address",
      2048,
    );
    if (typeof sourceUri === "string" && !/^https:\/\/\S+$/.test(sourceUri)) {
      fail(collected, "source_uri", "Source address must be an https address.");
    }
    const sourceTitle = requiredText(
      collected,
      form,
      "source_title",
      "Source title",
      300,
    );
    const retrieved = instantField(
      collected,
      form,
      "retrieved_at",
      "Retrieved at",
      true,
    );
    if (typeof retrieved === "number" && retrieved > sources.clock()) {
      fail(collected, "retrieved_at", "Retrieved at cannot be in the future.");
    }
    if (
      hasErrors(collected) ||
      authorityType === null ||
      citation === null ||
      sourceUri === undefined ||
      sourceTitle === null ||
      typeof retrieved !== "number"
    ) {
      return invalid(collected.errors);
    }
    const checked = await policyChangeContext(sources, versionId);
    if (!("version" in checked)) {
      return checked;
    }
    const input: AuthorityReferenceInput = {
      versionId,
      authorityType,
      citationText: citation,
      sourceUri,
      sourceTitle,
      retrievedAt: new Date(retrieved).toISOString(),
    };
    return sent(
      () => checked.context.writes.addAuthorityReference(input),
      ADD_REFERENCE_OUTCOMES,
    );
  });
}

// Records a human verification decision on one authority reference. The
// verifier is the caller, as the database records it.
export async function decideAuthorityReference(
  sources: ConfigurationSources,
  formData: unknown,
): Promise<ConfigurationActionState> {
  return guarded(formData, async (form) => {
    const referenceId = idField(form, "reference");
    const decision = single(form, "decision");
    if (
      referenceId === null ||
      (decision !== "verified" && decision !== "rejected")
    ) {
      return UNAVAILABLE;
    }
    const context = await contextOf(sources);
    if (!("userId" in context)) {
      return context;
    }
    const reference = await oneOf(
      () => context.reads.authorityReferenceById(referenceId),
      readAuthority,
      referenceId,
    );
    if (reference === undefined) {
      return UNAVAILABLE;
    }
    if (reference === null) {
      return DENIED;
    }
    const checked = await policyChangeContext(
      sources,
      reference.versionId,
      context,
    );
    if (!("version" in checked)) {
      return checked;
    }
    return sent(
      () =>
        checked.context.writes.decideAuthorityReference(referenceId, decision),
      DECIDE_REFERENCE_OUTCOMES,
    );
  });
}

// --- Jurisdictions and service areas ---------------------------------------

export async function createJurisdiction(
  sources: ConfigurationSources,
  formData: unknown,
): Promise<ConfigurationActionState> {
  return guarded(formData, async (form) => {
    const collected = newCollected();
    const code = codeField(
      collected,
      form,
      "code",
      "Code",
      /^[A-Z][A-Z0-9_]{1,31}$/,
      "must be 2 to 32 capital letters, digits, or underscores, starting with a letter.",
    );
    const name = requiredText(collected, form, "name", "Name", 120);
    const regionType = requiredText(
      collected,
      form,
      "region_type",
      "Region type",
      40,
    );
    if (
      hasErrors(collected) ||
      code === null ||
      name === null ||
      regionType === null
    ) {
      return invalid(collected.errors);
    }
    const context = await contextOf(sources);
    if (!("userId" in context)) {
      return context;
    }
    const refusal = await required(
      context.reads,
      "manage_jurisdiction_configuration",
      null,
    );
    if (refusal !== null) {
      return refusal;
    }
    return sent(
      () => context.writes.createJurisdiction(code, name, regionType),
      CREATE_JURISDICTION_OUTCOMES,
    );
  });
}

// The jurisdiction a change concerns, visible to the caller's own session,
// with the caller's capability for exactly that jurisdiction.
async function jurisdictionChangeContext(
  sources: ConfigurationSources,
  jurisdictionId: string,
  capability: StaffCapability,
): Promise<Context | ConfigurationActionState> {
  const context = await contextOf(sources);
  if (!("userId" in context)) {
    return context;
  }
  const jurisdiction = await visibleJurisdictionOf(
    context.reads,
    jurisdictionId,
  );
  if (!("id" in jurisdiction)) {
    return jurisdiction;
  }
  const refusal = await required(context.reads, capability, jurisdiction.id);
  return refusal ?? context;
}

export async function changeJurisdictionLifecycle(
  sources: ConfigurationSources,
  formData: unknown,
): Promise<ConfigurationActionState> {
  return guarded(formData, async (form) => {
    const jurisdictionId = idField(form, "jurisdiction");
    const expected = versionToken(form);
    if (jurisdictionId === null || expected === null) {
      return UNAVAILABLE;
    }
    const target = single(form, "target_state");
    if (!isOneOf(LIFECYCLE_STATES, target)) {
      return invalid({ target_state: ["Choose a lifecycle state."] });
    }
    const context = await jurisdictionChangeContext(
      sources,
      jurisdictionId,
      "manage_jurisdiction_configuration",
    );
    if (!("writes" in context)) {
      return context;
    }
    return sent(
      () =>
        context.writes.changeJurisdictionLifecycle(
          jurisdictionId,
          expected,
          target,
        ),
      LIFECYCLE_OUTCOMES,
    );
  });
}

export async function createServiceArea(
  sources: ConfigurationSources,
  formData: unknown,
): Promise<ConfigurationActionState> {
  return guarded(formData, async (form) => {
    const jurisdictionId = idField(form, "jurisdiction");
    if (jurisdictionId === null) {
      return UNAVAILABLE;
    }
    const collected = newCollected();
    const code = codeField(
      collected,
      form,
      "code",
      "Code",
      /^[A-Z][A-Z0-9_]{1,63}$/,
      "must be 2 to 64 capital letters, digits, or underscores, starting with a letter.",
    );
    const name = requiredText(collected, form, "name", "Name", 120);
    const from = instantField(
      collected,
      form,
      "active_from",
      "Active from",
      true,
    );
    const until = periodEnd(
      collected,
      form,
      "active_until",
      "Active until",
      from,
      "Active from",
    );
    if (
      hasErrors(collected) ||
      code === null ||
      name === null ||
      typeof from !== "number" ||
      until === undefined
    ) {
      return invalid(collected.errors);
    }
    const context = await jurisdictionChangeContext(
      sources,
      jurisdictionId,
      "manage_jurisdiction_configuration",
    );
    if (!("writes" in context)) {
      return context;
    }
    const input: ServiceAreaInput = {
      jurisdictionId,
      code,
      name,
      activeFrom: new Date(from).toISOString(),
      activeUntil: isoOf(until),
    };
    return sent(
      () => context.writes.createServiceArea(input),
      CREATE_SERVICE_AREA_OUTCOMES,
    );
  });
}

// --- Practice-area catalog -------------------------------------------------

export async function createPracticeArea(
  sources: ConfigurationSources,
  formData: unknown,
): Promise<ConfigurationActionState> {
  return guarded(formData, async (form) => {
    const collected = newCollected();
    const code = codeField(
      collected,
      form,
      "code",
      "Code",
      /^[a-z][a-z0-9_]{1,63}$/,
      "must be 2 to 64 lowercase letters, digits, or underscores, starting with a letter.",
    );
    const name = requiredText(collected, form, "name", "Name", 120);
    if (hasErrors(collected) || code === null || name === null) {
      return invalid(collected.errors);
    }
    const context = await contextOf(sources);
    if (!("userId" in context)) {
      return context;
    }
    const refusal = await required(
      context.reads,
      "manage_jurisdiction_configuration",
      null,
    );
    if (refusal !== null) {
      return refusal;
    }
    return sent(
      () => context.writes.createPracticeArea(code, name),
      CREATE_PRACTICE_AREA_OUTCOMES,
    );
  });
}

export async function setPracticeAreaActive(
  sources: ConfigurationSources,
  formData: unknown,
): Promise<ConfigurationActionState> {
  return guarded(formData, async (form) => {
    const areaId = idField(form, "practice_area");
    const active = single(form, "active");
    if (areaId === null || (active !== "true" && active !== "false")) {
      return UNAVAILABLE;
    }
    const context = await contextOf(sources);
    if (!("userId" in context)) {
      return context;
    }
    const refusal = await required(
      context.reads,
      "manage_jurisdiction_configuration",
      null,
    );
    if (refusal !== null) {
      return refusal;
    }
    return sent(
      () => context.writes.setPracticeAreaActive(areaId, active === "true"),
      PRACTICE_AREA_ACTIVITY_OUTCOMES,
    );
  });
}

// --- Launch gates and authorization ----------------------------------------

export async function defineLaunchGate(
  sources: ConfigurationSources,
  formData: unknown,
): Promise<ConfigurationActionState> {
  return guarded(formData, async (form) => {
    const jurisdictionId = idField(form, "jurisdiction");
    if (jurisdictionId === null) {
      return UNAVAILABLE;
    }
    const collected = newCollected();
    const code = codeField(
      collected,
      form,
      "gate_code",
      "Gate code",
      /^[a-z][a-z0-9_]{2,63}$/,
      "must be 3 to 64 lowercase letters, digits, or underscores, starting with a letter.",
    );
    const requiredRaw = single(form, "required");
    if (requiredRaw !== "yes" && requiredRaw !== "no") {
      fail(collected, "required", "Choose whether the gate is required.");
    }
    const description = optionalText(
      collected,
      form,
      "description",
      "Description",
      500,
    );
    if (hasErrors(collected) || code === null || description === undefined) {
      return invalid(collected.errors);
    }
    const context = await jurisdictionChangeContext(
      sources,
      jurisdictionId,
      "manage_jurisdiction_configuration",
    );
    if (!("writes" in context)) {
      return context;
    }
    return sent(
      () =>
        context.writes.defineLaunchGate(
          jurisdictionId,
          code,
          requiredRaw === "yes",
          description,
        ),
      DEFINE_GATE_OUTCOMES,
    );
  });
}

export async function recordLaunchGateEvaluation(
  sources: ConfigurationSources,
  formData: unknown,
): Promise<ConfigurationActionState> {
  return guarded(formData, async (form) => {
    const gateId = idField(form, "gate");
    if (gateId === null) {
      return UNAVAILABLE;
    }
    const collected = newCollected();
    const status = single(form, "evaluation_status");
    if (status !== "passed" && status !== "failed") {
      fail(collected, "evaluation_status", "Choose passed or failed.");
    }
    const evidence = jsonObjectField(
      collected,
      form,
      "evidence_reference",
      "Evidence reference",
      8192,
      false,
    );
    const reason = requiredText(collected, form, "reason", "Reason", 500);
    if (
      hasErrors(collected) ||
      (status !== "passed" && status !== "failed") ||
      evidence === undefined ||
      reason === null
    ) {
      return invalid(collected.errors);
    }
    const context = await contextOf(sources);
    if (!("userId" in context)) {
      return context;
    }
    const gate = await oneOf(
      () => context.reads.launchGateById(gateId),
      readGate,
      gateId,
    );
    if (gate === undefined) {
      return UNAVAILABLE;
    }
    if (gate === null) {
      return DENIED;
    }
    const refusal = await required(
      context.reads,
      "manage_jurisdiction_configuration",
      gate.jurisdictionId,
    );
    if (refusal !== null) {
      return refusal;
    }
    return sent(
      () =>
        context.writes.recordLaunchGateEvaluation(
          gateId,
          status,
          evidence,
          reason,
        ),
      GATE_EVALUATION_OUTCOMES,
    );
  });
}

export async function grantLaunchAuthorization(
  sources: ConfigurationSources,
  formData: unknown,
): Promise<ConfigurationActionState> {
  return guarded(formData, async (form) => {
    const jurisdictionId = idField(form, "jurisdiction");
    if (jurisdictionId === null) {
      return UNAVAILABLE;
    }
    const collected = newCollected();
    const reason = requiredText(collected, form, "reason", "Reason", 500);
    if (reason === null) {
      return invalid(collected.errors);
    }
    const context = await jurisdictionChangeContext(
      sources,
      jurisdictionId,
      "authorize_jurisdiction_launch",
    );
    if (!("writes" in context)) {
      return context;
    }
    return sent(
      () => context.writes.grantLaunchAuthorization(jurisdictionId, reason),
      GRANT_LAUNCH_OUTCOMES,
    );
  });
}

export async function revokeLaunchAuthorization(
  sources: ConfigurationSources,
  formData: unknown,
): Promise<ConfigurationActionState> {
  return guarded(formData, async (form) => {
    const authorizationId = idField(form, "authorization");
    if (authorizationId === null) {
      return UNAVAILABLE;
    }
    const collected = newCollected();
    const reason = requiredText(collected, form, "reason", "Reason", 500);
    if (reason === null) {
      return invalid(collected.errors);
    }
    const context = await contextOf(sources);
    if (!("userId" in context)) {
      return context;
    }
    const authorization = await oneOf(
      () => context.reads.launchAuthorizationById(authorizationId),
      readAuthorization,
      authorizationId,
    );
    if (authorization === undefined) {
      return UNAVAILABLE;
    }
    if (authorization === null) {
      return DENIED;
    }
    const refusal = await required(
      context.reads,
      "authorize_jurisdiction_launch",
      authorization.jurisdictionId,
    );
    if (refusal !== null) {
      return refusal;
    }
    return sent(
      () => context.writes.revokeLaunchAuthorization(authorizationId, reason),
      REVOKE_LAUNCH_OUTCOMES,
    );
  });
}

// --- Capability administration ---------------------------------------------

export async function grantCapability(
  sources: ConfigurationSources,
  formData: unknown,
): Promise<ConfigurationActionState> {
  return guarded(formData, async (form) => {
    const memberId = idField(form, "member");
    if (memberId === null) {
      return UNAVAILABLE;
    }
    const collected = newCollected();
    const capability = codeField(
      collected,
      form,
      "capability_code",
      "Capability",
      /^[a-z][a-z0-9_]{2,63}$/,
      "must be chosen from the list.",
    );
    const scope = scopeField(collected, form);
    const expires = instantField(
      collected,
      form,
      "expires_at",
      "Expires at",
      false,
    );
    if (typeof expires === "number" && expires <= sources.clock()) {
      fail(collected, "expires_at", "Expires at must be in the future.");
    }
    if (
      hasErrors(collected) ||
      capability === null ||
      scope === undefined ||
      expires === undefined
    ) {
      return invalid(collected.errors);
    }
    const context = await contextOf(sources);
    if (!("userId" in context)) {
      return context;
    }
    const refusal = await required(
      context.reads,
      "manage_staff_capabilities",
      null,
    );
    if (refusal !== null) {
      return refusal;
    }
    // Nobody grants themselves a capability; the database refuses it too.
    if (memberId === context.userId) {
      return refused("self_grant_refused");
    }
    return sent(
      () =>
        context.writes.grantCapability(
          memberId,
          capability,
          scope,
          isoOf(expires),
        ),
      GRANT_CAPABILITY_OUTCOMES,
    );
  });
}

export async function revokeCapability(
  sources: ConfigurationSources,
  formData: unknown,
): Promise<ConfigurationActionState> {
  return guarded(formData, async (form) => {
    const grantId = idField(form, "grant");
    if (grantId === null) {
      return UNAVAILABLE;
    }
    const context = await contextOf(sources);
    if (!("userId" in context)) {
      return context;
    }
    const refusal = await required(
      context.reads,
      "manage_staff_capabilities",
      null,
    );
    if (refusal !== null) {
      return refusal;
    }
    return sent(
      () => context.writes.revokeCapability(grantId),
      REVOKE_CAPABILITY_OUTCOMES,
    );
  });
}

// --- Intake configuration --------------------------------------------------

// Publishes a new immutable intake question-set version. The definition is
// checked against the format-1 rules before anything is sent; the database
// checks it again, together with what only it can check.
export async function publishQuestionSet(
  sources: ConfigurationSources,
  formData: unknown,
): Promise<ConfigurationActionState> {
  return guarded(formData, async (form) => {
    const collected = newCollected();
    const versionKey = codeField(
      collected,
      form,
      "version_key",
      "Version key",
      /^[a-z][a-z0-9-]{2,63}$/,
      "must be 3 to 64 lowercase letters, digits, or hyphens, starting with a letter.",
    );
    const definition = jsonObjectField(
      collected,
      form,
      "definition",
      "Definition",
      65536,
      true,
    );
    if (
      definition !== null &&
      definition !== undefined &&
      parseDefinition(definition) === null
    ) {
      fail(
        collected,
        "definition",
        "Definition does not follow the intake question-set format (format 1).",
      );
    }
    if (
      hasErrors(collected) ||
      versionKey === null ||
      definition === null ||
      definition === undefined
    ) {
      return invalid(collected.errors);
    }
    const context = await contextOf(sources);
    if (!("userId" in context)) {
      return context;
    }
    const refusal = await required(
      context.reads,
      "manage_intake_configuration",
      null,
    );
    if (refusal !== null) {
      return refusal;
    }
    return sent(
      () => context.writes.publishQuestionSet(versionKey, definition),
      PUBLISH_QUESTION_SET_OUTCOMES,
    );
  });
}
