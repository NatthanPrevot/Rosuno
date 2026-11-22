// Staff administration workspaces (MVP-001 S11 pass 2; MBS sections 16
// "Operations" and 18.4; TA sections 18, 40 and 41; DM sections 3 and 5; MB
// sections 19, 22 and 81 to 90; PM row 46).
//
// Provider-neutral and injectable: each request hands in its own ports.
// - Client administration (manage_client_accounts, global grant): account
//   metadata and counts only, and the audited suspend and reactivate
//   commands with a staff note.
// - Attorney lifecycle (manage_attorney_verification, global grant, the rule
//   of the existing suspend intent): reinstate and remove with a staff note.
// - The compliance workspace: each section only for holders of its own
//   capability (attorney records by verification scope; the compliance review
//   items; complaint counts; recent policy status changes; active Legal Holds).
// The application only refuses early and reads strictly; the database
// decides the capability, the scope, the transition and the self-action rule
// again and audits every change.

import type { EnvironmentConfiguration } from "./environment-binding.ts";
import { jurisdictionNamesOf } from "./operations-workspace.ts";
import {
  attempt,
  DENIED,
  portFrom,
  rowsOf,
  textField,
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
} from "./professional-records.ts";
import {
  verifiedStaffWith,
  verifiedStaffWithAny,
  type ConfigurationSources,
  type StaffCapability,
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

export const CLIENT_ACCOUNTS_CAPABILITY: StaffCapability =
  "manage_client_accounts";
export const VERIFICATION_CAPABILITY: StaffCapability =
  "manage_attorney_verification";

export const MAX_STAFF_NOTE = 500;

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export const ACCOUNT_STATES = Object.freeze([
  "pending_verification",
  "active",
  "suspended",
  "closed",
] as const);
export type AccountState = (typeof ACCOUNT_STATES)[number];

export const CLIENT_INTENTS = Object.freeze(["suspend", "reactivate"] as const);
export type ClientIntent = (typeof CLIENT_INTENTS)[number];
export const CLIENT_OUTCOMES = Object.freeze([
  "applied",
  "invalid",
  "denied",
  "not_found",
  "locked",
]);

export const LIFECYCLE_INTENTS = Object.freeze([
  "reinstate",
  "remove",
] as const);
export type LifecycleIntent = (typeof LIFECYCLE_INTENTS)[number];
export const LIFECYCLE_OUTCOMES = Object.freeze([
  "applied",
  "invalid",
  "denied",
  "locked",
  "review_required",
]);

export const COMPLIANCE_SECTIONS = Object.freeze([
  "under_review",
  "approved",
  "suspended",
  "removed",
  "license_expiry",
  "insurance_expiry",
  "evidence_age",
  "discipline",
  "waitlist",
] as const);
export type ComplianceSection = (typeof COMPLIANCE_SECTIONS)[number];

export type AdministrationReads = {
  // staff_clients(p_account_state, p_offset)
  readonly clients: (
    state: AccountState | null,
    offset: number,
  ) => Promise<RowsResult>;
  // staff_client(p_client_account_id)
  readonly client: (clientId: string) => Promise<RowsResult>;
  // staff_attorney_profile(p_attorney_id)
  readonly attorneyProfile: (attorneyId: string) => Promise<RowsResult>;
  // staff_compliance_summary()
  readonly complianceSummary: () => Promise<RowsResult>;
  // staff_compliance_records(p_section, p_offset)
  readonly complianceRecords: (
    section: ComplianceSection,
    offset: number,
  ) => Promise<RowsResult>;
  // staff_policy_changes(p_offset)
  readonly policyChanges: (offset: number) => Promise<RowsResult>;
  // staff_jurisdiction_names()
  readonly jurisdictionNames: () => Promise<RowsResult>;
  // deployment_environment_identity()
  readonly environmentIdentity: () => Promise<RowsResult>;
};

export type AdministrationWrites = {
  // staff_change_client_account(p_client_account_id, p_intent, p_note)
  readonly changeClientAccount: (
    clientId: string,
    intent: ClientIntent,
    note: string,
  ) => Promise<CommandAnswer>;
  // staff_change_attorney_lifecycle(p_attorney_id, p_intent, p_note)
  readonly changeAttorneyLifecycle: (
    attorneyId: string,
    intent: LifecycleIntent,
    note: string,
  ) => Promise<CommandAnswer>;
};

export type AdministrationSources = {
  readonly staff: ConfigurationSources;
  readonly reads: () => Promise<AdministrationReads | null>;
  readonly writes: () => Promise<AdministrationWrites | null>;
  readonly environment: () => EnvironmentConfiguration;
};

async function readsFor(
  sources: AdministrationSources,
  capability: StaffCapability,
  scope: "global" | "any",
): Promise<{ readonly reads: AdministrationReads } | Refusal> {
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

// Sends one change after the capability check and the environment binding,
// and settles the database's answer through the command's own table.
async function changed<Outcome extends string>(
  sources: AdministrationSources,
  capability: StaffCapability,
  call: (writes: AdministrationWrites) => Promise<CommandAnswer>,
  table: Readonly<Record<string, Outcome>>,
): Promise<ActionState<Outcome>> {
  const context = await readsFor(sources, capability, "global");
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

// The staff note of a change: required, at most 500 characters.
function noteOf(value: string | undefined): string | null {
  const note = textField(value, MAX_STAFF_NOTE);
  return note === null || note === "" ? null : note;
}

// ---------------------------------------------------------------------------
// Client administration
// ---------------------------------------------------------------------------

export const CLIENT_COLUMNS = Object.freeze([
  "user_id",
  "display_name",
  "account_state",
  "created_at",
  "intakes",
  "requests",
  "consultations",
  "open_requests",
  "open_consultations",
  "open_complaints",
]);

export type ClientAccount = {
  readonly id: string;
  readonly displayName: string | null;
  readonly state: AccountState;
  readonly createdAt: string;
  readonly intakes: number;
  readonly requests: number;
  readonly consultations: number;
  readonly openRequests: number;
  readonly openConsultations: number;
  readonly openComplaints: number;
};

function readClient(row: unknown): ClientAccount | null {
  const f = readExact(row, CLIENT_COLUMNS);
  if (f === null) {
    return null;
  }
  const value = {
    id: f.get("user_id"),
    displayName: f.get("display_name"),
    state: f.get("account_state"),
    createdAt: f.get("created_at"),
    intakes: f.get("intakes"),
    requests: f.get("requests"),
    consultations: f.get("consultations"),
    openRequests: f.get("open_requests"),
    openConsultations: f.get("open_consultations"),
    openComplaints: f.get("open_complaints"),
  };
  if (
    !isUuid(value.id) ||
    !(
      value.displayName === null ||
      (typeof value.displayName === "string" && value.displayName.length <= 200)
    ) ||
    !isOneOf(ACCOUNT_STATES, value.state) ||
    !isTimestamp(value.createdAt) ||
    !isCount(value.intakes) ||
    !isCount(value.requests) ||
    !isCount(value.consultations) ||
    !isCount(value.openRequests) ||
    !isCount(value.openConsultations) ||
    !isCount(value.openComplaints) ||
    value.openRequests > value.requests ||
    value.openConsultations > value.consultations
  ) {
    return null;
  }
  return Object.freeze(value) as ClientAccount;
}

export function accountStateFilterOf(value: unknown): AccountState | null {
  return isOneOf(ACCOUNT_STATES, value) ? value : null;
}

export type ClientsView =
  | {
      readonly status: "ready";
      readonly stateFilter: AccountState | null;
      readonly clients: readonly ClientAccount[];
      readonly pager: StaffPager;
    }
  | Refusal;

export async function resolveClients(
  sources: AdministrationSources,
  stateValue: unknown,
  pageValue: unknown,
): Promise<ClientsView> {
  try {
    const stateFilter = accountStateFilterOf(stateValue);
    const page = staffPageOf(pageValue);
    const context = await readsFor(
      sources,
      CLIENT_ACCOUNTS_CAPABILITY,
      "global",
    );
    if (!("reads" in context)) {
      return context;
    }
    const read = staffPageRows(
      rowsOf(
        await attempt(() =>
          context.reads.clients(stateFilter, staffOffsetOf(page)),
        ),
      ),
      readClient,
      page,
    );
    if (
      read === null ||
      (stateFilter !== null &&
        read.rows.some((client) => client.state !== stateFilter))
    ) {
      return UNAVAILABLE;
    }
    return Object.freeze({
      status: "ready",
      stateFilter,
      clients: read.rows,
      pager: read.pager,
    });
  } catch {
    return UNAVAILABLE;
  }
}

export type ClientView =
  { readonly status: "ready"; readonly client: ClientAccount | null } | Refusal;

// One client; an unknown id, a non-client, a staff account and a malformed
// id alike show nothing.
export async function resolveClient(
  sources: AdministrationSources,
  clientValue: unknown,
): Promise<ClientView> {
  try {
    const context = await readsFor(
      sources,
      CLIENT_ACCOUNTS_CAPABILITY,
      "global",
    );
    if (!("reads" in context)) {
      return context;
    }
    const clientId =
      typeof clientValue === "string" ? clientValue.toLowerCase() : null;
    if (!isUuid(clientId)) {
      return Object.freeze({ status: "ready", client: null });
    }
    const rows = rowsOf(await attempt(() => context.reads.client(clientId)));
    if (rows === null || rows.length > 1) {
      return UNAVAILABLE;
    }
    if (rows.length === 0) {
      return Object.freeze({ status: "ready", client: null });
    }
    const client = readClient(rows[0]);
    return client === null || client.id !== clientId
      ? UNAVAILABLE
      : Object.freeze({ status: "ready", client });
  } catch {
    return UNAVAILABLE;
  }
}

export const CLIENT_ACTION_OUTCOMES = Object.freeze([
  "account_suspended",
  "account_reactivated",
  "not_found",
  "state_changed",
] as const);
export type ClientActionOutcome = (typeof CLIENT_ACTION_OUTCOMES)[number];
export type ClientActionState = ActionState<ClientActionOutcome>;
export const INITIAL_CLIENT_STATE: ClientActionState = IDLE;

// Suspends or reactivates one client's account with a staff note.
export async function changeClientAccount(
  sources: AdministrationSources,
  formData: unknown,
): Promise<ClientActionState> {
  try {
    const fields = formFieldsOf(formData, ["client", "intent", "note"]);
    const clientId = fields?.get("client")?.trim().toLowerCase();
    const intent = fields?.get("intent");
    const note = noteOf(fields?.get("note"));
    if (
      !isUuid(clientId) ||
      !isOneOf(CLIENT_INTENTS, intent) ||
      note === null
    ) {
      return INVALID;
    }
    return await changed(
      sources,
      CLIENT_ACCOUNTS_CAPABILITY,
      (writes) => writes.changeClientAccount(clientId, intent, note),
      Object.freeze({
        applied:
          intent === "suspend" ? "account_suspended" : "account_reactivated",
        not_found: "not_found",
        locked: "state_changed",
      } satisfies Record<string, ClientActionOutcome>),
    );
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Attorney lifecycle
// ---------------------------------------------------------------------------

export const PROFILE_STATES = Object.freeze([
  "applicant",
  "under_review",
  "approved",
  "suspended",
  "removed",
] as const);
export type ProfileStage = (typeof PROFILE_STATES)[number];

export type AttorneyLifecycle = {
  readonly id: string;
  readonly displayName: string | null;
  readonly state: ProfileStage;
  readonly updatedAt: string;
  readonly rejoinReviewOpen: boolean;
};

export type AttorneyLifecycleView =
  | {
      readonly status: "ready";
      readonly attorney: AttorneyLifecycle | null;
    }
  | Refusal;

// One Attorney Profile for the lifecycle commands (the global verification
// grant); an unknown or malformed id shows nothing.
export async function resolveAttorneyLifecycle(
  sources: AdministrationSources,
  attorneyValue: unknown,
): Promise<AttorneyLifecycleView> {
  try {
    const context = await readsFor(sources, VERIFICATION_CAPABILITY, "global");
    if (!("reads" in context)) {
      return context;
    }
    const attorneyId =
      typeof attorneyValue === "string" ? attorneyValue.toLowerCase() : null;
    if (!isUuid(attorneyId)) {
      return Object.freeze({ status: "ready", attorney: null });
    }
    const rows = rowsOf(
      await attempt(() => context.reads.attorneyProfile(attorneyId)),
    );
    if (rows === null || rows.length > 1) {
      return UNAVAILABLE;
    }
    if (rows.length === 0) {
      return Object.freeze({ status: "ready", attorney: null });
    }
    const f = readExact(rows[0], [
      "attorney_id",
      "display_name",
      "profile_state",
      "updated_at",
      "rejoin_review_open",
    ]);
    const value = {
      id: f?.get("attorney_id"),
      displayName: f?.get("display_name"),
      state: f?.get("profile_state"),
      updatedAt: f?.get("updated_at"),
      rejoinReviewOpen: f?.get("rejoin_review_open"),
    };
    if (
      f === null ||
      value.id !== attorneyId ||
      !(
        value.displayName === null ||
        (typeof value.displayName === "string" &&
          value.displayName.length <= 200)
      ) ||
      !isOneOf(PROFILE_STATES, value.state) ||
      !isTimestamp(value.updatedAt) ||
      typeof value.rejoinReviewOpen !== "boolean"
    ) {
      return UNAVAILABLE;
    }
    return Object.freeze({
      status: "ready",
      attorney: Object.freeze(value) as AttorneyLifecycle,
    });
  } catch {
    return UNAVAILABLE;
  }
}

// The intents offered for a stage: reinstate a suspended profile; remove an
// approved or suspended one. Nothing for any other stage.
export function lifecycleIntentsFor(
  state: ProfileStage,
): readonly LifecycleIntent[] {
  if (state === "suspended") {
    return Object.freeze(["reinstate", "remove"] as const);
  }
  return state === "approved"
    ? Object.freeze(["remove"] as const)
    : Object.freeze([]);
}

export const LIFECYCLE_ACTION_OUTCOMES = Object.freeze([
  "attorney_reinstated",
  "attorney_removed",
  "stage_changed",
  "review_required",
] as const);
export type LifecycleActionOutcome = (typeof LIFECYCLE_ACTION_OUTCOMES)[number];
export type LifecycleActionState = ActionState<LifecycleActionOutcome>;
export const INITIAL_LIFECYCLE_STATE: LifecycleActionState = IDLE;

// Reinstates or removes one Attorney Profile with a staff note.
export async function changeAttorneyLifecycle(
  sources: AdministrationSources,
  formData: unknown,
): Promise<LifecycleActionState> {
  try {
    const fields = formFieldsOf(formData, ["attorney", "intent", "note"]);
    const attorneyId = fields?.get("attorney")?.trim().toLowerCase();
    const intent = fields?.get("intent");
    const note = noteOf(fields?.get("note"));
    if (
      !isUuid(attorneyId) ||
      !isOneOf(LIFECYCLE_INTENTS, intent) ||
      note === null
    ) {
      return INVALID;
    }
    return await changed(
      sources,
      VERIFICATION_CAPABILITY,
      (writes) => writes.changeAttorneyLifecycle(attorneyId, intent, note),
      Object.freeze({
        applied:
          intent === "reinstate" ? "attorney_reinstated" : "attorney_removed",
        locked: "stage_changed",
        review_required: "review_required",
      } satisfies Record<string, LifecycleActionOutcome>),
    );
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// The compliance workspace
// ---------------------------------------------------------------------------

export const COMPLIANCE_SUMMARY_DIMENSIONS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  attorney_profiles: PROFILE_STATES,
  waitlist: Object.freeze(["members"]),
  compliance_reviews: Object.freeze([
    "eligibility_change_review",
    "jurisdiction_change_review",
    "rejoin_review",
    "client_account_review",
  ]),
  complaints: Object.freeze(["opened", "in_review", "escalated", "resolved"]),
  legal_holds: Object.freeze(["active"]),
});

export type ComplianceCounts = Readonly<
  Record<
    string,
    readonly { readonly dimension: string; readonly value: number }[]
  >
>;

// The summary rows, read strictly: each group either absent or complete, in
// order.
export function readComplianceSummary(
  rows: readonly unknown[] | null,
): ComplianceCounts | null {
  if (rows === null) {
    return null;
  }
  const groups: Record<string, { dimension: string; value: number }[]> = {};
  for (const row of rows) {
    const f = readExact(row, ["metric", "dimension", "value"]);
    const metric = f?.get("metric");
    const dimension = f?.get("dimension");
    const value = f?.get("value");
    if (
      f === null ||
      typeof metric !== "string" ||
      !Object.hasOwn(COMPLIANCE_SUMMARY_DIMENSIONS, metric) ||
      typeof dimension !== "string" ||
      !isCount(value)
    ) {
      return null;
    }
    const list = (groups[metric] ??= []);
    if (COMPLIANCE_SUMMARY_DIMENSIONS[metric][list.length] !== dimension) {
      return null;
    }
    list.push(Object.freeze({ dimension, value }));
  }
  for (const [metric, list] of Object.entries(groups)) {
    if (list.length !== COMPLIANCE_SUMMARY_DIMENSIONS[metric].length) {
      return null;
    }
  }
  if (
    (groups.attorney_profiles === undefined) !==
    (groups.waitlist === undefined)
  ) {
    return null;
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(groups).map(([key, list]) => [key, Object.freeze(list)]),
    ),
  );
}

export const COMPLIANCE_RECORD_COLUMNS = Object.freeze([
  "record_type",
  "record_id",
  "attorney_id",
  "display_name",
  "profile_state",
  "jurisdiction_id",
  "status_code",
  "recorded_at",
  "lapses_on",
]);
export const RECORD_TYPES = Object.freeze([
  "license",
  "insurance",
  "attorney_profile",
  "discipline_record",
] as const);

export type ComplianceRecord = {
  readonly recordType: (typeof RECORD_TYPES)[number];
  readonly recordId: string;
  readonly attorneyId: string;
  readonly displayName: string | null;
  readonly profileState: ProfileStage;
  readonly jurisdictionId: string | null;
  readonly statusCode: string | null;
  readonly recordedAt: string | null;
  readonly lapsesOn: string | null;
};

// The record types a section answers.
const SECTION_TYPES: Readonly<
  Record<ComplianceSection, readonly (typeof RECORD_TYPES)[number][]>
> = Object.freeze({
  under_review: ["attorney_profile"],
  approved: ["attorney_profile"],
  suspended: ["attorney_profile"],
  removed: ["attorney_profile"],
  license_expiry: ["license"],
  insurance_expiry: ["insurance"],
  evidence_age: ["license", "insurance"],
  discipline: ["discipline_record"],
  waitlist: ["license"],
});

function recordReader(section: ComplianceSection) {
  return (row: unknown): ComplianceRecord | null => {
    const f = readExact(row, COMPLIANCE_RECORD_COLUMNS);
    if (f === null) {
      return null;
    }
    const value = {
      recordType: f.get("record_type"),
      recordId: f.get("record_id"),
      attorneyId: f.get("attorney_id"),
      displayName: f.get("display_name"),
      profileState: f.get("profile_state"),
      jurisdictionId: f.get("jurisdiction_id"),
      statusCode: f.get("status_code"),
      recordedAt: f.get("recorded_at"),
      lapsesOn: f.get("lapses_on"),
    };
    const profileSection =
      section === "under_review" ||
      section === "approved" ||
      section === "suspended" ||
      section === "removed";
    if (
      !isOneOf(SECTION_TYPES[section], value.recordType) ||
      !isUuid(value.recordId) ||
      !isUuid(value.attorneyId) ||
      !(
        value.displayName === null ||
        (typeof value.displayName === "string" &&
          value.displayName.length <= 200)
      ) ||
      !isOneOf(PROFILE_STATES, value.profileState) ||
      (profileSection && value.profileState !== section) ||
      !(value.jurisdictionId === null || isUuid(value.jurisdictionId)) ||
      profileSection !== (value.jurisdictionId === null) ||
      !(value.statusCode === null || isCode(value.statusCode)) ||
      !(value.recordedAt === null || isTimestamp(value.recordedAt)) ||
      !(value.lapsesOn === null || isDate(value.lapsesOn))
    ) {
      return null;
    }
    return Object.freeze(value) as ComplianceRecord;
  };
}

export const POLICY_CHANGE_COLUMNS = Object.freeze([
  "audit_event_id",
  "policy_version_id",
  "policy_type_code",
  "jurisdiction_id",
  "from_status",
  "to_status",
  "occurred_at",
]);

export type PolicyChange = {
  readonly id: string;
  readonly versionId: string;
  readonly typeCode: string;
  readonly jurisdictionId: string | null;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly occurredAt: string;
};

function readPolicyChange(row: unknown): PolicyChange | null {
  const f = readExact(row, POLICY_CHANGE_COLUMNS);
  if (f === null) {
    return null;
  }
  const value = {
    id: f.get("audit_event_id"),
    versionId: f.get("policy_version_id"),
    typeCode: f.get("policy_type_code"),
    jurisdictionId: f.get("jurisdiction_id"),
    fromStatus: f.get("from_status"),
    toStatus: f.get("to_status"),
    occurredAt: f.get("occurred_at"),
  };
  if (
    !isUuid(value.id) ||
    !isUuid(value.versionId) ||
    !isCode(value.typeCode) ||
    !(value.jurisdictionId === null || isUuid(value.jurisdictionId)) ||
    !(value.fromStatus === null || isCode(value.fromStatus)) ||
    !(value.toStatus === null || isCode(value.toStatus)) ||
    !isTimestamp(value.occurredAt)
  ) {
    return null;
  }
  return Object.freeze(value) as PolicyChange;
}

export function complianceSectionOf(value: unknown): ComplianceSection {
  return isOneOf(COMPLIANCE_SECTIONS, value) ? value : "under_review";
}

export type ComplianceHeld = {
  readonly verification: boolean;
  readonly reviews: boolean;
  readonly complaints: boolean;
  readonly policy: boolean;
  readonly legalHolds: boolean;
};

// An optional section's own state: not held by the caller (not presented),
// read, or not readable right now (presented as unavailable while the rest
// of the workspace is shown).
export type ComplianceSectionState = "not_held" | "ready" | "unavailable";

export type ComplianceView =
  | {
      readonly status: "ready";
      readonly held: ComplianceHeld;
      // The caller may open an attorney's lifecycle page (the global
      // manage_attorney_verification grant that page requires).
      readonly attorneyPages: boolean;
      readonly counts: ComplianceCounts;
      readonly section: ComplianceSection;
      readonly sections: {
        readonly records: ComplianceSectionState;
        readonly policyChanges: ComplianceSectionState;
      };
      // Present only while their section is ready.
      readonly records: readonly ComplianceRecord[] | null;
      readonly pager: StaffPager | null;
      readonly policyChanges: readonly PolicyChange[] | null;
      readonly names: ReadonlyMap<string, string>;
    }
  | Refusal;

async function held(
  sources: AdministrationSources,
  capability: StaffCapability,
  scope: "global" | "any",
): Promise<boolean | Refusal> {
  const staff =
    scope === "global"
      ? await verifiedStaffWith(sources.staff, capability)
      : await verifiedStaffWithAny(sources.staff, capability);
  if ("userId" in staff) {
    return true;
  }
  return staff.status === "denied" ? false : staff;
}

// The compliance workspace: each section only for holders of its own
// capability; a caller holding none of them is refused (as is any caller the
// capability checks refuse). The summary and the jurisdiction names are the
// workspace itself; each optional section (the attorney records, the policy
// status changes) has its own state, so one that cannot be read is shown as
// unavailable without withholding the others.
export async function resolveComplianceWorkspace(
  sources: AdministrationSources,
  sectionValue: unknown,
  pageValue: unknown,
): Promise<ComplianceView> {
  try {
    const section = complianceSectionOf(sectionValue);
    const page = staffPageOf(pageValue);
    const answers = [
      await held(sources, VERIFICATION_CAPABILITY, "any"),
      await held(sources, "manage_compliance_reviews", "global"),
      await held(sources, "manage_complaints", "any"),
      await held(sources, "manage_policy_configuration", "any"),
      await held(sources, "manage_legal_holds", "global"),
    ];
    for (const answer of answers) {
      if (typeof answer !== "boolean") {
        return answer;
      }
    }
    const [verification, reviews, complaints, policy, legalHolds] =
      answers as boolean[];
    if (!verification && !reviews && !complaints && !policy && !legalHolds) {
      return DENIED;
    }
    const attorneyPages = verification
      ? await held(sources, VERIFICATION_CAPABILITY, "global")
      : false;
    if (typeof attorneyPages !== "boolean") {
      return attorneyPages;
    }
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const [names, summaryRows] = await Promise.all([
      jurisdictionNamesOf(() => reads.jurisdictionNames()),
      attempt(() => reads.complianceSummary()),
    ]);
    const counts = readComplianceSummary(rowsOf(summaryRows));
    if (names === null || counts === null) {
      return UNAVAILABLE;
    }
    let records: readonly ComplianceRecord[] | null = null;
    let pager: StaffPager | null = null;
    let recordsState: ComplianceSectionState = "not_held";
    if (verification) {
      const read = staffPageRows(
        rowsOf(
          await attempt(() =>
            reads.complianceRecords(section, staffOffsetOf(page)),
          ),
        ),
        recordReader(section),
        page,
      );
      recordsState = read === null ? "unavailable" : "ready";
      records = read?.rows ?? null;
      pager = read?.pager ?? null;
    }
    let policyChanges: readonly PolicyChange[] | null = null;
    let policyState: ComplianceSectionState = "not_held";
    if (policy) {
      const read = staffPageRows(
        rowsOf(await attempt(() => reads.policyChanges(0))),
        readPolicyChange,
        1,
      );
      policyState = read === null ? "unavailable" : "ready";
      policyChanges = read?.rows ?? null;
    }
    return Object.freeze({
      status: "ready",
      held: Object.freeze({
        verification,
        reviews,
        complaints,
        policy,
        legalHolds,
      }),
      attorneyPages,
      counts,
      section,
      sections: Object.freeze({
        records: recordsState,
        policyChanges: policyState,
      }),
      records,
      pager,
      policyChanges,
      names,
    });
  } catch {
    return UNAVAILABLE;
  }
}
