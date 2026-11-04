// Restricted staff verification workspace (P3-003).
//
// Provider-neutral and injectable. For every read and every change it
// establishes afresh, on the server: the trusted session subject, a fresh
// Auth read of that account with a confirmed email, the account's one active
// Rosuno User, that User's one active Staff Profile, and, for the exact
// jurisdiction a read or change concerns, the database's own
// manage_attorney_verification scope predicate answered for the caller's own
// session. A Staff Profile alone grants nothing; a grant that is revoked,
// expired, resource-scoped, for another jurisdiction, or unreadable denies.
// Profile-level review needs the global (jurisdiction-free) scope, exactly
// as the database's own read policy for attorney profiles does. Staff never
// review their own attorney profile.
//
// What staff see is read through the request's own session under the
// database's row policies, so it is never wider than those policies allow.
// Changes run through the privileged port only after authorization, keyed by
// the authorized record and guarded by its current state. Evidence records
// what a named source showed, when, how, and by whom; an unavailable source
// is recorded as an audit event and never as evidence. No regulator answer,
// verified label, policy, or approval rule is invented. Eligibility
// determinations are persisted only on an explicit request, as immutable
// evaluations; viewing a current assessment persists nothing.

import {
  assessEligibility,
  evaluationRowOf,
  type EligibilityAssessment,
} from "./eligibility-assessment.ts";
import {
  ELIGIBILITY_POLICY_TYPE,
  POLICY_VERSION_COLUMNS,
} from "./policy-selection.ts";
import {
  auditEventOf,
  AUDIT_ACTIONS,
  runAuditedChange,
  type AuditedOutcome,
  type AuditedResult,
  type AuditEvent,
} from "./professional-audit.ts";
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
  isOneOf,
  isUuid,
  readDiscipline,
  readEvaluation,
  readEvidence,
  readEvidenceSubject,
  readExact,
  readInsurance,
  readJurisdiction,
  readLicense,
  readPracticeArea,
  readPracticeAuthorisation,
  readProfile,
  readRows,
  STAFF_STATES,
  type DisciplineRecord,
  type EvidenceRecord,
  type InsuranceRecord,
  type LicenseRecord,
  type PracticeAuthorisationRecord,
  type ProfileRecord,
  type ProfileState,
  type SubjectKind,
} from "./professional-records.ts";
import type { ServerSessionSource } from "./session.ts";

export const STAFF_PROFILE_COLUMNS = "id, user_id, staff_state";

// The database predicate's answer for the caller's own session.
export type ScopeAnswer =
  | { readonly kind: "answer"; readonly granted: boolean }
  | { readonly kind: "unreadable" };

// Request-scoped, unprivileged reads under the database's row policies.
export type StaffReads = {
  readonly usersOf: (accountId: string) => Promise<RowsResult>;
  readonly staffProfilesOf: (userId: string) => Promise<RowsResult>;
  readonly ownAttorneyProfilesOf: (userId: string) => Promise<RowsResult>;
  readonly holdsVerificationScope: (
    jurisdictionId: string | null,
  ) => Promise<ScopeAnswer>;
  readonly attorneyProfiles: () => Promise<RowsResult>;
  readonly attorneyProfileById: (attorneyId: string) => Promise<RowsResult>;
  readonly licensesOf: (attorneyId: string) => Promise<RowsResult>;
  readonly insuranceOf: (attorneyId: string) => Promise<RowsResult>;
  readonly disciplineOf: (attorneyId: string) => Promise<RowsResult>;
  readonly authorisationsOf: (attorneyId: string) => Promise<RowsResult>;
  readonly pendingAuthorisations: () => Promise<RowsResult>;
  readonly visibleLicenses: () => Promise<RowsResult>;
  readonly recordById: (
    kind: SubjectKind,
    recordId: string,
  ) => Promise<RowsResult>;
  readonly evidenceSubjectsFor: (
    kind: SubjectKind,
    recordIds: readonly string[],
  ) => Promise<RowsResult>;
  readonly evidenceByIds: (
    evidenceIds: readonly string[],
  ) => Promise<RowsResult>;
  readonly evaluationsOf: (attorneyId: string) => Promise<RowsResult>;
  readonly practiceAreas: () => Promise<RowsResult>;
};

export type EvidenceInsert = {
  readonly id: string;
  readonly jurisdiction_id: string | null;
  readonly source_type: string;
  readonly source_uri: string | null;
  readonly source_reference: string;
  readonly retrieved_at: string;
  readonly retrieved_by_user_id: string;
  readonly evidence_summary: string;
  readonly evidence_digest: string | null;
  readonly verification_method: string;
  readonly discrepancy_flag: boolean;
};

export type DisciplineInsert = {
  readonly jurisdiction_id: string;
  readonly external_reference: string | null;
  readonly finding_type: string | null;
  readonly opened_at: string | null;
  readonly resolved_at: string | null;
  readonly status: string;
};

export type AuthorisationDecision = {
  readonly status: "authorised" | "refused";
  readonly decided_at: string;
  readonly effective_from: string | null;
  readonly effective_until: string | null;
};

export type ReviewTransition = {
  readonly from: "under_review" | "approved";
  readonly to: "approved" | "applicant" | "suspended";
};

// Server-only, privileged port with narrow, exact-key operations.
export type StaffProvisioning = {
  readonly jurisdictions: () => Promise<RowsResult>;
  readonly attorneyProfileOf: (attorneyId: string) => Promise<RowsResult>;
  readonly accountStateOf: (userId: string) => Promise<RowsResult>;
  readonly licensesIn: (
    attorneyId: string,
    jurisdictionId: string,
  ) => Promise<RowsResult>;
  readonly insuranceIn: (
    attorneyId: string,
    jurisdictionId: string,
  ) => Promise<RowsResult>;
  readonly disciplineIn: (
    attorneyId: string,
    jurisdictionId: string,
  ) => Promise<RowsResult>;
  readonly authorisationsIn: (
    attorneyId: string,
    jurisdictionId: string,
  ) => Promise<RowsResult>;
  readonly evidenceSubjectsOf: (
    kind: SubjectKind,
    recordIds: readonly string[],
  ) => Promise<RowsResult>;
  readonly evidenceOf: (evidenceIds: readonly string[]) => Promise<RowsResult>;
  readonly policyVersionsFor: (
    policyTypeCode: string,
    jurisdictionId: string,
  ) => Promise<RowsResult>;
  readonly authorityReferencesFor: (
    versionIds: readonly string[],
  ) => Promise<RowsResult>;
  readonly insertEvidence: (evidence: EvidenceInsert) => Promise<RowsResult>;
  readonly linkEvidence: (
    evidenceId: string,
    kind: SubjectKind,
    recordId: string,
  ) => Promise<RowsResult>;
  readonly recordLicenseObservation: (
    attorneyId: string,
    licenseId: string,
    expectedUpdatedAt: string,
    reportedStatus: string,
  ) => Promise<RowsResult>;
  readonly insertDiscipline: (
    attorneyId: string,
    disciplineId: string,
    record: DisciplineInsert,
  ) => Promise<RowsResult>;
  readonly updateDisciplineStatus: (
    attorneyId: string,
    recordId: string,
    expectedUpdatedAt: string,
    status: string,
    resolvedAt: string | null,
  ) => Promise<RowsResult>;
  readonly decideAuthorisation: (
    attorneyId: string,
    authorisationId: string,
    expectedUpdatedAt: string,
    decision: AuthorisationDecision,
  ) => Promise<RowsResult>;
  readonly transitionProfile: (
    attorneyId: string,
    transition: ReviewTransition,
  ) => Promise<RowsResult>;
  readonly evaluationById: (evaluationId: string) => Promise<RowsResult>;
  readonly insertEvaluation: (
    row: Readonly<Record<string, unknown>>,
  ) => Promise<RowsResult>;
  readonly insertAuditEvent: (event: AuditEvent) => Promise<RowsResult>;
  readonly profileHistoryOf: (attorneyId: string) => Promise<RowsResult>;
};

export type StaffSources = {
  readonly session: ServerSessionSource;
  readonly account: AccountSource;
  readonly reads: () => Promise<StaffReads | null>;
  readonly provisioning: () => Promise<StaffProvisioning | null>;
  readonly clock: () => number;
  // A new record id generated on the server for each insert, so the audit
  // attempt names the exact record and verification reads it by id.
  readonly newId: () => string;
};

// ---------------------------------------------------------------------------
// Staff identity and scope
// ---------------------------------------------------------------------------

type StaffContext = {
  readonly userId: string;
  // The staff member's own attorney profile, if any, never reviewable here.
  readonly ownAttorneyId: string | null;
};

async function staffContextOf(
  sources: StaffSources,
  reads: StaffReads,
): Promise<StaffContext | Refusal> {
  const account = await confirmedAccountOf(sources.session, sources.account);
  if (!("accountId" in account)) {
    return account;
  }
  const user = await activeUserOf(reads.usersOf, account.accountId);
  if (!("userId" in user)) {
    return user;
  }
  const staff = rowsOf(await attempt(() => reads.staffProfilesOf(user.userId)));
  if (staff === null || staff.length > 1) {
    return UNAVAILABLE;
  }
  if (staff.length === 0) {
    return DENIED;
  }
  const row = readExact(staff[0], STAFF_PROFILE_COLUMNS.split(", "));
  if (
    row === null ||
    !isUuid(row.get("id")) ||
    row.get("user_id") !== user.userId ||
    !isOneOf(STAFF_STATES, row.get("staff_state"))
  ) {
    return UNAVAILABLE;
  }
  if (row.get("staff_state") !== "active") {
    return DENIED;
  }
  const own = rowsOf(
    await attempt(() => reads.ownAttorneyProfilesOf(user.userId)),
  );
  if (own === null || own.length > 1) {
    return UNAVAILABLE;
  }
  const ownProfile = own.length === 1 ? readProfile(own[0]) : null;
  if (
    own.length === 1 &&
    (ownProfile === null || ownProfile.userId !== user.userId)
  ) {
    return UNAVAILABLE;
  }
  return { userId: user.userId, ownAttorneyId: ownProfile?.id ?? null };
}

// Whether the caller holds the scope for exactly this jurisdiction (null
// means the global, jurisdiction-free scope), or null when unreadable.
async function holds(
  reads: StaffReads,
  jurisdictionId: string | null,
): Promise<boolean | null> {
  const answer = readExact(
    await attempt(() => reads.holdsVerificationScope(jurisdictionId)),
    ["kind", "granted"],
  );
  const granted = answer?.get("granted");
  return answer?.get("kind") === "answer" && typeof granted === "boolean"
    ? granted
    : null;
}

type Scope = {
  readonly global: boolean;
  readonly jurisdictions: ReadonlySet<string>;
};

// The caller's scope over the configured jurisdictions, asked one exact
// jurisdiction at a time, or null when any answer is unreadable.
async function scopeOf(
  reads: StaffReads,
  jurisdictionIds: readonly string[],
): Promise<Scope | null> {
  const global = await holds(reads, null);
  if (global === null) {
    return null;
  }
  const held = new Set<string>();
  for (const id of jurisdictionIds) {
    const answer = global ? true : await holds(reads, id);
    if (answer === null) {
      return null;
    }
    if (answer) {
      held.add(id);
    }
  }
  return { global, jurisdictions: held };
}

// ---------------------------------------------------------------------------
// Shared reading helpers
// ---------------------------------------------------------------------------

function listOf<T>(
  result: unknown,
  reader: (row: unknown) => T | null,
): readonly T[] | null {
  const rows = rowsOf(result);
  return rows === null ? null : readRows(rows, reader);
}

type Named = { readonly id: string; readonly label: string };

async function jurisdictionsOf(
  provisioning: StaffProvisioning,
): Promise<readonly Named[] | null> {
  const list = listOf(
    await attempt(() => provisioning.jurisdictions()),
    readJurisdiction,
  );
  return list === null
    ? null
    : list.map((j) => ({ id: j.id, label: `${j.name} (${j.code})` }));
}

const SUBJECT_KINDS = Object.freeze([
  "license",
  "insurance",
  "discipline",
  "practice_area_authorisation",
] as const satisfies readonly SubjectKind[]);

type AnyRecord =
  | LicenseRecord
  | InsuranceRecord
  | DisciplineRecord
  | PracticeAuthorisationRecord;

const READERS: Readonly<
  Record<SubjectKind, (row: unknown) => AnyRecord | null>
> = Object.freeze({
  license: readLicense,
  insurance: readInsurance,
  discipline: readDiscipline,
  practice_area_authorisation: readPracticeAuthorisation,
});

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export type QueueEntry = {
  readonly attorneyId: string;
  readonly name: string;
  readonly stage: ProfileState | null;
  readonly pendingRequests: number;
  readonly licenseClaims: number;
};

export type StaffQueueView =
  | typeof SIGN_IN_REQUIRED
  | typeof DENIED
  | typeof UNAVAILABLE
  | {
      readonly status: "ready";
      readonly global: boolean;
      readonly scope: readonly string[];
      readonly entries: readonly QueueEntry[];
    };

const STAGE_ORDER: Readonly<Record<ProfileState, number>> = {
  under_review: 0,
  applicant: 1,
  approved: 2,
  suspended: 3,
  removed: 4,
};

// The authorized review queue: every attorney profile the global scope can
// read, or, for a jurisdiction-scoped reviewer, the attorneys whose license
// claims or pending practice-area requests the row policies show. The
// caller's own attorney profile never appears.
export async function resolveStaffQueue(
  sources: StaffSources,
): Promise<StaffQueueView> {
  try {
    const reads = await portFrom(sources.reads);
    const provisioning = await portFrom(sources.provisioning);
    if (reads === null || provisioning === null) {
      return UNAVAILABLE;
    }
    const staff = await staffContextOf(sources, reads);
    if (!("userId" in staff)) {
      return staff;
    }
    const jurisdictions = await jurisdictionsOf(provisioning);
    if (jurisdictions === null) {
      return UNAVAILABLE;
    }
    const scope = await scopeOf(
      reads,
      jurisdictions.map((j) => j.id),
    );
    if (scope === null) {
      return UNAVAILABLE;
    }
    if (!scope.global && scope.jurisdictions.size === 0) {
      return DENIED;
    }
    const [profileRows, licenseRows, requestRows] = await Promise.all([
      scope.global
        ? attempt(() => reads.attorneyProfiles())
        : Promise.resolve(Object.freeze({ kind: "rows", rows: [] })),
      attempt(() => reads.visibleLicenses()),
      attempt(() => reads.pendingAuthorisations()),
    ]);
    const profiles = listOf(profileRows, readProfile);
    const licenses = listOf(licenseRows, readLicense);
    const requests = listOf(requestRows, readPracticeAuthorisation);
    if (profiles === null || licenses === null || requests === null) {
      return UNAVAILABLE;
    }
    const inScope = (jurisdictionId: string) =>
      scope.global || scope.jurisdictions.has(jurisdictionId);
    const entries = new Map<string, QueueEntry>();
    const touch = (attorneyId: string): QueueEntry => {
      const existing = entries.get(attorneyId);
      if (existing !== undefined) {
        return existing;
      }
      const created: QueueEntry = {
        attorneyId,
        name: "Attorney record",
        stage: null,
        pendingRequests: 0,
        licenseClaims: 0,
      };
      entries.set(attorneyId, created);
      return created;
    };
    for (const profile of profiles) {
      if (profile.id === staff.ownAttorneyId || profile.state === "removed") {
        continue;
      }
      entries.set(profile.id, {
        ...touch(profile.id),
        name: profile.displayName?.trim() || "Name not provided",
        stage: profile.state,
      });
    }
    for (const license of licenses) {
      if (
        license.attorneyId === staff.ownAttorneyId ||
        !inScope(license.jurisdictionId)
      ) {
        continue;
      }
      if (scope.global && !entries.has(license.attorneyId)) {
        continue;
      }
      const entry = touch(license.attorneyId);
      entries.set(license.attorneyId, {
        ...entry,
        licenseClaims: entry.licenseClaims + 1,
      });
    }
    for (const request of requests) {
      if (
        request.attorneyId === staff.ownAttorneyId ||
        request.status !== "requested" ||
        !inScope(request.jurisdictionId)
      ) {
        continue;
      }
      if (scope.global && !entries.has(request.attorneyId)) {
        continue;
      }
      const entry = touch(request.attorneyId);
      entries.set(request.attorneyId, {
        ...entry,
        pendingRequests: entry.pendingRequests + 1,
      });
    }
    const sorted = [...entries.values()].sort(
      (a, b) =>
        (a.stage === null ? 5 : STAGE_ORDER[a.stage]) -
          (b.stage === null ? 5 : STAGE_ORDER[b.stage]) ||
        b.pendingRequests - a.pendingRequests ||
        (a.attorneyId < b.attorneyId ? -1 : 1),
    );
    return Object.freeze({
      status: "ready",
      global: scope.global,
      scope: Object.freeze(
        scope.global
          ? ["All jurisdictions"]
          : jurisdictions
              .filter((j) => scope.jurisdictions.has(j.id))
              .map((j) => j.label),
      ),
      entries: Object.freeze(sorted.map((entry) => Object.freeze(entry))),
    });
  } catch {
    return UNAVAILABLE;
  }
}

export type EvidenceView = {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceReference: string;
  readonly sourceUri: string;
  readonly method: string;
  readonly retrievedAt: string;
  readonly reviewer: "you" | "another reviewer" | "not recorded";
  readonly discrepancy: boolean;
  readonly summary: string;
};

export type RecordView = {
  readonly kind: SubjectKind;
  readonly id: string;
  readonly jurisdictionId: string | null;
  readonly jurisdiction: string;
  readonly title: string;
  readonly details: readonly (readonly [string, string])[];
  readonly evidence: readonly EvidenceView[];
  readonly canRecordFinding: boolean;
  readonly canDecide: boolean;
};

export type AssessmentView = {
  readonly jurisdictionId: string;
  readonly jurisdiction: string;
  readonly assessment: EligibilityAssessment;
  readonly canRecord: boolean;
};

export type EvaluationView = {
  readonly id: string;
  readonly jurisdiction: string;
  readonly context: string;
  readonly result: string;
  readonly evaluatedAt: string;
  readonly factors: readonly {
    readonly factor: string;
    readonly outcome: string;
    readonly reason: string;
  }[];
};

export type HistoryView = {
  readonly occurredAt: string;
  readonly action: string;
  readonly detail: string;
};

export type StaffReviewView =
  | typeof SIGN_IN_REQUIRED
  | typeof DENIED
  | typeof UNAVAILABLE
  | {
      readonly status: "ready";
      readonly attorneyId: string;
      readonly global: boolean;
      // Present only to the global scope, which the profile policy admits.
      readonly profile: {
        readonly name: string;
        readonly headline: string;
        readonly yearsExperience: string;
        readonly stage: ProfileState;
        readonly transitions: readonly ReviewIntent[];
      } | null;
      readonly records: readonly RecordView[];
      readonly assessments: readonly AssessmentView[];
      readonly evaluations: readonly EvaluationView[];
      readonly history: readonly HistoryView[];
      readonly disciplineJurisdictions: readonly {
        readonly value: string;
        readonly label: string;
      }[];
      readonly practiceAreas: readonly {
        readonly value: string;
        readonly label: string;
      }[];
    };

// Profile stages in which staff may record findings and decisions: never
// while the applicant is editing, and never on a removed profile.
const FINDING_STAGES: readonly ProfileState[] = Object.freeze([
  "under_review",
  "approved",
  "suspended",
]);
const DECISION_STAGES: readonly ProfileState[] = Object.freeze([
  "under_review",
  "approved",
]);

export const REVIEW_INTENTS = Object.freeze([
  "approve",
  "request_information",
  "suspend",
] as const);
export type ReviewIntent = (typeof REVIEW_INTENTS)[number];

// The only profile transitions staff can make here, each from exactly one
// existing stage to exactly one existing stage.
const TRANSITIONS: Readonly<Record<ReviewIntent, ReviewTransition>> =
  Object.freeze({
    approve: Object.freeze({ from: "under_review", to: "approved" }),
    request_information: Object.freeze({
      from: "under_review",
      to: "applicant",
    }),
    suspend: Object.freeze({ from: "approved", to: "suspended" }),
  });

function intentsFrom(stage: ProfileState): readonly ReviewIntent[] {
  return Object.freeze(
    REVIEW_INTENTS.filter((intent) => TRANSITIONS[intent].from === stage),
  );
}

function shown(value: string | number | null): string {
  return value === null ? "Not stated" : String(value);
}

function recordDetails(
  kind: SubjectKind,
  record: AnyRecord,
  areaNames: ReadonlyMap<string, string>,
) {
  switch (kind) {
    case "license": {
      const r = record as LicenseRecord;
      return {
        title: `License ${r.licenseNumber}`,
        details: [
          ["License type", shown(r.licenseType)],
          ["Effective from", shown(r.effectiveFrom)],
          ["Effective until", shown(r.effectiveUntil)],
          ["Source-observed status", r.reportedStatus ?? "Not yet observed"],
        ] as const,
      };
    }
    case "insurance": {
      const r = record as InsuranceRecord;
      return {
        title: `Insurance with ${shown(r.carrierName)}`,
        details: [
          ["Policy reference", shown(r.policyReference)],
          ["Coverage type", shown(r.coverageType)],
          ["Per-claim limit (minor units)", shown(r.perOccurrenceLimitMinor)],
          ["Aggregate limit (minor units)", shown(r.aggregateLimitMinor)],
          ["Currency", shown(r.currencyCode)],
          ["Coverage", `${shown(r.coverageFrom)} to ${shown(r.coverageUntil)}`],
        ] as const,
      };
    }
    case "discipline": {
      const r = record as DisciplineRecord;
      return {
        title: `Discipline record ${shown(r.externalReference)}`,
        details: [
          ["Finding type", shown(r.findingType)],
          ["Opened", shown(r.openedAt)],
          ["Resolved", shown(r.resolvedAt)],
          ["Status", shown(r.status)],
        ] as const,
      };
    }
    default: {
      const r = record as PracticeAuthorisationRecord;
      return {
        title: `Practice area: ${areaNames.get(r.practiceAreaId) ?? "Unavailable"}`,
        details: [
          ["Status", r.status],
          ["Requested", r.requestedAt],
          ["Decided", shown(r.decidedAt)],
          [
            "Effective",
            `${shown(r.effectiveFrom)} to ${shown(r.effectiveUntil)}`,
          ],
        ] as const,
      };
    }
  }
}

// The privileged facts of one attorney in one jurisdiction, read for a
// server-side assessment only, and the assessment at asOfMs.
async function assessmentOf(
  provisioning: StaffProvisioning,
  attorneyId: string,
  jurisdictionId: string,
  practiceAreaId: string | null,
  asOfMs: number,
): Promise<EligibilityAssessment> {
  const profileRows = rowsOf(
    await attempt(() => provisioning.attorneyProfileOf(attorneyId)),
  );
  const profile =
    profileRows?.length === 1 ? readProfile(profileRows[0]) : null;
  let accountState: unknown = undefined;
  if (profile !== null) {
    const accountRows = rowsOf(
      await attempt(() => provisioning.accountStateOf(profile.userId)),
    );
    const account =
      accountRows?.length === 1
        ? readExact(accountRows[0], ["id", "account_state"])
        : null;
    accountState =
      account?.get("id") === profile.userId
        ? account.get("account_state")
        : undefined;
  }
  const [licenses, insurance, discipline, authorisations, versions] =
    await Promise.all([
      attempt(() => provisioning.licensesIn(attorneyId, jurisdictionId)),
      attempt(() => provisioning.insuranceIn(attorneyId, jurisdictionId)),
      attempt(() => provisioning.disciplineIn(attorneyId, jurisdictionId)),
      attempt(() => provisioning.authorisationsIn(attorneyId, jurisdictionId)),
      attempt(() =>
        provisioning.policyVersionsFor(ELIGIBILITY_POLICY_TYPE, jurisdictionId),
      ),
    ]);
  const lists = {
    license: rowsOf(licenses),
    insurance: rowsOf(insurance),
    discipline: rowsOf(discipline),
    practice_area_authorisation: rowsOf(authorisations),
  };
  const subjects: unknown[] = [];
  let subjectsReadable = true;
  for (const kind of SUBJECT_KINDS) {
    const ids = (lists[kind] ?? [])
      .map((row) => READERS[kind](row)?.id)
      .filter(isUuid);
    if (ids.length === 0) {
      continue;
    }
    const rows = rowsOf(
      await attempt(() => provisioning.evidenceSubjectsOf(kind, ids)),
    );
    if (rows === null) {
      subjectsReadable = false;
      break;
    }
    subjects.push(...rows);
  }
  const evidenceIds = [
    ...new Set(
      subjects
        .map((row) => readEvidenceSubject(row)?.evidenceId)
        .filter(isUuid),
    ),
  ];
  const evidence =
    evidenceIds.length === 0
      ? []
      : rowsOf(await attempt(() => provisioning.evidenceOf(evidenceIds)));
  const versionRows = rowsOf(versions);
  const versionIds = (versionRows ?? [])
    .map((row) => readExact(row, POLICY_VERSION_COLUMNS.split(", "))?.get("id"))
    .filter(isUuid);
  const authorities =
    versionRows === null
      ? null
      : versionIds.length === 0
        ? []
        : rowsOf(
            await attempt(() =>
              provisioning.authorityReferencesFor(versionIds),
            ),
          );
  return assessEligibility(
    {
      attorneyId,
      jurisdictionId,
      practiceAreaId,
      accountState,
      profile: profileRows?.length === 1 ? profileRows[0] : null,
      licenses: lists.license,
      insurance: lists.insurance,
      discipline: lists.discipline,
      authorisations: lists.practice_area_authorisation,
      evidence: subjectsReadable ? evidence : null,
      subjects: subjectsReadable ? subjects : null,
      policyVersions: versionRows,
      authorityReferences: authorities,
    },
    asOfMs,
  );
}

// The privileged profile of an attorney, read for gating a change only.
async function gatingProfileOf(
  provisioning: StaffProvisioning,
  attorneyId: string,
): Promise<ProfileRecord | null> {
  const rows = rowsOf(
    await attempt(() => provisioning.attorneyProfileOf(attorneyId)),
  );
  const profile = rows?.length === 1 ? readProfile(rows[0]) : null;
  return profile?.id === attorneyId ? profile : null;
}

const HISTORY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  [AUDIT_ACTIONS.applicationSubmitted]: "Application submission requested",
  [AUDIT_ACTIONS.profileStateChanged]:
    "Profile stage change requested by review staff",
  [AUDIT_ACTIONS.informationRequested]: "Additional information requested",
  [AUDIT_ACTIONS.profileDetailsRevised]:
    "Profile details revision requested by the applicant",
  [AUDIT_ACTIONS.outcome]: "Outcome recorded",
});

const OUTCOME_LABELS: Readonly<Record<string, string>> = Object.freeze({
  applied: "applied",
  partially_applied: "partially applied",
  not_applied: "not applied",
  unknown: "could not be confirmed",
});

// One own string field of a snapshot object, or undefined.
function snapshotText(snapshot: unknown, key: string): string | undefined {
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(snapshot, key);
  const value =
    descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  return typeof value === "string" ? value : undefined;
}

// The profile's audit history. Under the write-ahead protocol an attempt
// row records what was requested and an outcome row what actually
// persisted, with whether the actor's authority still held at completion.
function historyOf(rows: readonly unknown[]): readonly HistoryView[] | null {
  const views: { at: number; view: HistoryView }[] = [];
  for (const row of rows) {
    const f = readExact(row, ["occurred_at", "action_code", "after_snapshot"]);
    const at = f?.get("occurred_at");
    const action = f?.get("action_code");
    if (
      f === null ||
      typeof at !== "string" ||
      typeof action !== "string" ||
      Number.isNaN(Date.parse(at))
    ) {
      return null;
    }
    const after = f.get("after_snapshot");
    const state = snapshotText(after, "profile_state");
    const message = snapshotText(after, "message_to_applicant");
    const outcome = snapshotText(after, "outcome");
    const authority = snapshotText(after, "authority");
    const attempted = snapshotText(after, "attempted_action");
    const detail =
      action === AUDIT_ACTIONS.outcome
        ? [
            `${HISTORY_LABELS[attempted ?? ""] ?? "Change"}: ${OUTCOME_LABELS[outcome ?? ""] ?? "not recorded"}`,
            authority === "held"
              ? ""
              : `Actor authority at check: ${authority ?? "not recorded"}`,
          ]
        : [
            typeof state === "string" ? `Stage: ${state}` : "",
            typeof message === "string" ? `Message: ${message}` : "",
          ];
    views.push({
      at: Date.parse(at),
      view: Object.freeze({
        occurredAt: at,
        action: HISTORY_LABELS[action] ?? "Recorded change",
        detail: detail.filter((part) => part !== "").join(". "),
      }),
    });
  }
  return Object.freeze(
    views.sort((a, b) => b.at - a.at).map((entry) => entry.view),
  );
}

function evaluationViewOf(
  evaluation: NonNullable<ReturnType<typeof readEvaluation>>,
  jurisdictions: ReadonlyMap<string, string>,
  areas: ReadonlyMap<string, string>,
): EvaluationView {
  const factors = Array.isArray(evaluation.factorResults)
    ? evaluation.factorResults.flatMap((entry: unknown) => {
        const f = readExact(entry, ["factor", "outcome", "reason", "records"]);
        const name = f?.get("factor");
        const outcome = f?.get("outcome");
        const reason = f?.get("reason");
        return typeof name === "string" &&
          typeof outcome === "string" &&
          typeof reason === "string"
          ? [Object.freeze({ factor: name, outcome, reason })]
          : [];
      })
    : [];
  return Object.freeze({
    id: evaluation.id,
    jurisdiction: jurisdictions.get(evaluation.jurisdictionId) ?? "Unavailable",
    context:
      evaluation.contextType === "practice_area" &&
      evaluation.contextId !== null
        ? `Practice area: ${areas.get(evaluation.contextId) ?? "Unavailable"}`
        : "Jurisdiction",
    result: evaluation.result,
    evaluatedAt: evaluation.evaluatedAt,
    factors: Object.freeze(factors),
  });
}

// Resolves one attorney's review for the current request. It reads only
// what the caller's own session may read, computes current assessments for
// the jurisdictions in scope without persisting them, and never throws.
export async function resolveStaffReview(
  sources: StaffSources,
  attorneyIdParam: unknown,
): Promise<StaffReviewView> {
  try {
    const reads = await portFrom(sources.reads);
    const provisioning = await portFrom(sources.provisioning);
    if (reads === null || provisioning === null) {
      return UNAVAILABLE;
    }
    const staff = await staffContextOf(sources, reads);
    if (!("userId" in staff)) {
      return staff;
    }
    if (!isUuid(attorneyIdParam)) {
      return DENIED;
    }
    const attorneyId = attorneyIdParam;
    if (attorneyId === staff.ownAttorneyId) {
      return DENIED;
    }
    const jurisdictions = await jurisdictionsOf(provisioning);
    if (jurisdictions === null) {
      return UNAVAILABLE;
    }
    const scope = await scopeOf(
      reads,
      jurisdictions.map((j) => j.id),
    );
    if (scope === null) {
      return UNAVAILABLE;
    }
    if (!scope.global && scope.jurisdictions.size === 0) {
      return DENIED;
    }
    const [
      profileRows,
      licenseRows,
      insuranceRows,
      disciplineRows,
      authorisationRows,
      evaluationRows,
      areaRows,
    ] = await Promise.all([
      scope.global
        ? attempt(() => reads.attorneyProfileById(attorneyId))
        : Promise.resolve(Object.freeze({ kind: "rows", rows: [] })),
      attempt(() => reads.licensesOf(attorneyId)),
      attempt(() => reads.insuranceOf(attorneyId)),
      attempt(() => reads.disciplineOf(attorneyId)),
      attempt(() => reads.authorisationsOf(attorneyId)),
      attempt(() => reads.evaluationsOf(attorneyId)),
      attempt(() => reads.practiceAreas()),
    ]);
    const profiles = listOf(profileRows, readProfile);
    const byKind = {
      license: listOf(licenseRows, readLicense),
      insurance: listOf(insuranceRows, readInsurance),
      discipline: listOf(disciplineRows, readDiscipline),
      practice_area_authorisation: listOf(
        authorisationRows,
        readPracticeAuthorisation,
      ),
    };
    const evaluations = listOf(evaluationRows, readEvaluation);
    const areas = listOf(areaRows, readPracticeArea);
    if (
      profiles === null ||
      profiles.length > 1 ||
      SUBJECT_KINDS.some((kind) => byKind[kind] === null) ||
      evaluations === null ||
      areas === null
    ) {
      return UNAVAILABLE;
    }
    const profile = profiles.length === 1 ? profiles[0] : null;
    if (profile !== null && profile.id !== attorneyId) {
      return UNAVAILABLE;
    }
    const inScope = (jurisdictionId: string | null) =>
      scope.global ||
      (jurisdictionId !== null && scope.jurisdictions.has(jurisdictionId));
    const visible = SUBJECT_KINDS.flatMap((kind) =>
      (byKind[kind] ?? [])
        .filter(
          (record) =>
            record.attorneyId === attorneyId && inScope(record.jurisdictionId),
        )
        .map((record) => ({ kind, record })),
    );
    // Nothing readable for this attorney in the caller's scope looks exactly
    // like an attorney that does not exist.
    if (profile === null && visible.length === 0) {
      return DENIED;
    }
    const gating = await gatingProfileOf(provisioning, attorneyId);
    if (gating === null) {
      return UNAVAILABLE;
    }
    const jurisdictionNames = new Map(
      jurisdictions.map((j) => [j.id, j.label]),
    );
    const areaNames = new Map(areas.map((a) => [a.id, a.name]));
    const evidenceByRecord = new Map<string, EvidenceRecord[]>();
    for (const kind of SUBJECT_KINDS) {
      const ids = visible
        .filter((v) => v.kind === kind)
        .map((v) => v.record.id);
      if (ids.length === 0) {
        continue;
      }
      const subjects = listOf(
        await attempt(() => reads.evidenceSubjectsFor(kind, ids)),
        readEvidenceSubject,
      );
      if (subjects === null) {
        return UNAVAILABLE;
      }
      const evidenceIds = [...new Set(subjects.map((s) => s.evidenceId))];
      const evidence =
        evidenceIds.length === 0
          ? []
          : listOf(
              await attempt(() => reads.evidenceByIds(evidenceIds)),
              readEvidence,
            );
      if (evidence === null) {
        return UNAVAILABLE;
      }
      const byId = new Map(evidence.map((e) => [e.id, e]));
      for (const subject of subjects) {
        const entry = byId.get(subject.evidenceId);
        if (
          entry === undefined ||
          subject.kind !== kind ||
          !ids.includes(subject.subjectId)
        ) {
          continue;
        }
        evidenceByRecord.set(subject.subjectId, [
          ...(evidenceByRecord.get(subject.subjectId) ?? []),
          entry,
        ]);
      }
    }
    const findingsOpen = FINDING_STAGES.includes(gating.state);
    const decisionsOpen = DECISION_STAGES.includes(gating.state);
    const records: RecordView[] = visible.map(({ kind, record }) => {
      const { title, details } = recordDetails(kind, record, areaNames);
      const evidence = [...(evidenceByRecord.get(record.id) ?? [])].sort(
        (a, b) => Date.parse(b.retrievedAt) - Date.parse(a.retrievedAt),
      );
      return Object.freeze({
        kind,
        id: record.id,
        jurisdictionId: record.jurisdictionId,
        jurisdiction:
          record.jurisdictionId === null
            ? "No jurisdiction stated"
            : (jurisdictionNames.get(record.jurisdictionId) ?? "Unavailable"),
        title,
        details: Object.freeze(
          details.map((pair) => Object.freeze([pair[0], pair[1]] as const)),
        ),
        evidence: Object.freeze(
          evidence.map((e) =>
            Object.freeze({
              id: e.id,
              sourceType: e.sourceType ?? "Not recorded",
              sourceReference: e.sourceReference ?? "Not recorded",
              sourceUri: e.sourceUri ?? "",
              method: e.method ?? "Not recorded",
              retrievedAt: e.retrievedAt,
              reviewer:
                e.retrievedByUserId === null
                  ? "not recorded"
                  : e.retrievedByUserId === staff.userId
                    ? "you"
                    : "another reviewer",
              discrepancy: e.discrepancy,
              summary: e.summary ?? "",
            } satisfies EvidenceView),
          ),
        ),
        canRecordFinding: findingsOpen,
        canDecide:
          kind === "practice_area_authorisation" &&
          decisionsOpen &&
          (record as PracticeAuthorisationRecord).status === "requested",
      } satisfies RecordView);
    });
    const assessedJurisdictions = [
      ...new Set(
        visible
          .map((v) => v.record.jurisdictionId)
          .filter((id): id is string => id !== null && inScope(id)),
      ),
    ];
    const asOfMs = sources.clock();
    const assessments: AssessmentView[] = [];
    for (const jurisdictionId of assessedJurisdictions) {
      assessments.push(
        Object.freeze({
          jurisdictionId,
          jurisdiction: jurisdictionNames.get(jurisdictionId) ?? "Unavailable",
          assessment: await assessmentOf(
            provisioning,
            attorneyId,
            jurisdictionId,
            null,
            asOfMs,
          ),
          canRecord: true,
        }),
      );
    }
    let history: readonly HistoryView[] = Object.freeze([]);
    if (scope.global) {
      const rows = rowsOf(
        await attempt(() => provisioning.profileHistoryOf(attorneyId)),
      );
      const read = rows === null ? null : historyOf(rows);
      if (read === null) {
        return UNAVAILABLE;
      }
      history = read;
    }
    return Object.freeze({
      status: "ready",
      attorneyId,
      global: scope.global,
      profile:
        profile === null
          ? null
          : Object.freeze({
              name: profile.displayName?.trim() || "Name not provided",
              headline: profile.headline ?? "",
              yearsExperience: shown(profile.yearsExperience),
              stage: profile.state,
              transitions: intentsFrom(profile.state),
            }),
      records: Object.freeze(records),
      assessments: Object.freeze(assessments),
      evaluations: Object.freeze(
        evaluations
          .filter(
            (e) => e.attorneyId === attorneyId && inScope(e.jurisdictionId),
          )
          .sort((a, b) => Date.parse(b.evaluatedAt) - Date.parse(a.evaluatedAt))
          .map((e) => evaluationViewOf(e, jurisdictionNames, areaNames)),
      ),
      history,
      disciplineJurisdictions: Object.freeze(
        jurisdictions
          .filter((j) => inScope(j.id))
          .map((j) => Object.freeze({ value: j.id, label: j.label })),
      ),
      practiceAreas: Object.freeze(
        areas.map((a) => Object.freeze({ value: a.id, label: a.name })),
      ),
    });
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

export type FieldErrors = Readonly<Record<string, readonly string[]>>;

// "recorded": a fresh read shows the change and its audit row was written.
// "locked": the profile stage or record state does not allow it now.
// "not-saved": nothing changed (a concurrent change won). "unconfirmed": a
// write was attempted but could not be shown complete; nothing is claimed.
export type StaffActionState =
  | { readonly status: "idle" }
  | { readonly status: "recorded" }
  | { readonly status: "invalid"; readonly fieldErrors: FieldErrors }
  | { readonly status: "locked" }
  | { readonly status: "not-saved" }
  | { readonly status: "unconfirmed" }
  | typeof SIGN_IN_REQUIRED
  | typeof DENIED
  | typeof UNAVAILABLE;

export const INITIAL_STAFF_STATE: StaffActionState = Object.freeze({
  status: "idle",
});

const RECORDED = Object.freeze({ status: "recorded" } as const);
const LOCKED = Object.freeze({ status: "locked" } as const);
const NOT_SAVED = Object.freeze({ status: "not-saved" } as const);
const UNCONFIRMED = Object.freeze({ status: "unconfirmed" } as const);

function invalid(errors: Record<string, string[]>): StaffActionState {
  const copy: Record<string, readonly string[]> = {};
  for (const [field, messages] of Object.entries(errors)) {
    copy[field] = Object.freeze([...messages]);
  }
  return Object.freeze({ status: "invalid", fieldErrors: Object.freeze(copy) });
}

function single(formData: FormData, name: string): string | null {
  const values = formData.getAll(name);
  if (values.length === 0) {
    return "";
  }
  return values.length === 1 && typeof values[0] === "string"
    ? values[0]
    : null;
}

type Collected = { readonly errors: Record<string, string[]> };

function fail(collected: Collected, field: string, message: string): null {
  (collected.errors[field] ??= []).push(message);
  return null;
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
      `${label} must be ${max} characters or fewer.`,
    );
  }
  return value === ""
    ? fail(collected, field, `Enter ${label.toLowerCase()}.`)
    : value;
}

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
    fail(collected, field, `${label} must be ${max} characters or fewer.`);
    return undefined;
  }
  return value === "" ? null : value;
}

const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

// A YYYY-MM-DDTHH:MM value, read as UTC, as epoch milliseconds, or null.
function dateTimeOf(raw: string): number | null {
  const match = DATE_TIME.exec(raw.trim());
  if (match === null) {
    return null;
  }
  const ms = Date.parse(`${match[1]}T${match[2]}:${match[3]}:00Z`);
  return Number.isNaN(ms) ||
    new Date(ms).toISOString().slice(0, 16) !==
      `${match[1]}T${match[2]}:${match[3]}`
    ? null
    : ms;
}

function requiredInstant(
  collected: Collected,
  formData: FormData,
  field: string,
  label: string,
  notAfterMs: number,
): number | null {
  const raw = single(formData, field);
  const ms = raw === null ? null : dateTimeOf(raw);
  if (ms === null) {
    return fail(collected, field, `${label} must be a date and time (UTC).`);
  }
  if (ms > notAfterMs) {
    return fail(collected, field, `${label} cannot be in the future.`);
  }
  return ms;
}

function optionalDay(
  collected: Collected,
  formData: FormData,
  field: string,
  label: string,
): string | null | undefined {
  const raw = single(formData, field);
  if (raw === "") {
    return null;
  }
  const value = raw?.trim() ?? "";
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    fail(collected, field, `${label} must be a real date.`);
    return undefined;
  }
  return value;
}

type EvidenceFields = Omit<
  EvidenceInsert,
  "id" | "jurisdiction_id" | "retrieved_by_user_id"
>;

// The source-grounded evidence a reviewer submits: what source, which
// record at that source, when it was retrieved, how, what it showed, and
// whether it contradicts the claim.
function evidenceFieldsOf(
  collected: Collected,
  formData: FormData,
  nowMs: number,
): EvidenceFields | null {
  const sourceType = requiredText(
    collected,
    formData,
    "source_type",
    "Source type",
    80,
  );
  const sourceReference = requiredText(
    collected,
    formData,
    "source_reference",
    "Source reference",
    200,
  );
  const sourceUri = optionalText(
    collected,
    formData,
    "source_uri",
    "Source address",
    500,
  );
  if (typeof sourceUri === "string" && !/^https:\/\/[^\s]+$/.test(sourceUri)) {
    fail(collected, "source_uri", "Source address must be an https address.");
  }
  const retrieved = requiredInstant(
    collected,
    formData,
    "retrieved_at",
    "Retrieved at",
    nowMs,
  );
  const method = requiredText(
    collected,
    formData,
    "verification_method",
    "Method",
    80,
  );
  const summary = requiredText(
    collected,
    formData,
    "evidence_summary",
    "Finding summary",
    2000,
  );
  const digest = optionalText(
    collected,
    formData,
    "evidence_digest",
    "Document digest",
    128,
  );
  const outcome = single(formData, "outcome");
  if (outcome !== "consistent" && outcome !== "discrepancy") {
    fail(collected, "outcome", "Choose whether the source matches the claim.");
  }
  if (
    sourceType === null ||
    sourceReference === null ||
    sourceUri === undefined ||
    retrieved === null ||
    method === null ||
    summary === null ||
    digest === undefined ||
    (outcome !== "consistent" && outcome !== "discrepancy")
  ) {
    return null;
  }
  return {
    source_type: sourceType,
    source_uri: sourceUri,
    source_reference: sourceReference,
    retrieved_at: new Date(retrieved).toISOString(),
    evidence_summary: summary,
    evidence_digest: digest,
    verification_method: method,
    discrepancy_flag: outcome === "discrepancy",
  };
}

type Authorized = {
  readonly staff: StaffContext;
  readonly reads: StaffReads;
  readonly provisioning: StaffProvisioning;
};

async function authorizedStaffOf(
  sources: StaffSources,
): Promise<Authorized | Refusal> {
  const reads = await portFrom(sources.reads);
  if (reads === null) {
    return UNAVAILABLE;
  }
  const staff = await staffContextOf(sources, reads);
  if (!("userId" in staff)) {
    return staff;
  }
  const provisioning = await portFrom(sources.provisioning);
  if (provisioning === null) {
    return UNAVAILABLE;
  }
  return { staff, reads, provisioning };
}

// One record the caller's own session can read, by kind and id, or null.
async function visibleRecordOf(
  reads: StaffReads,
  kind: SubjectKind,
  recordId: string,
): Promise<AnyRecord | null | undefined> {
  const rows = rowsOf(await attempt(() => reads.recordById(kind, recordId)));
  if (rows === null || rows.length > 1) {
    return undefined;
  }
  if (rows.length === 0) {
    return null;
  }
  const record = READERS[kind](rows[0]);
  return record === null || record.id !== recordId ? undefined : record;
}

// The scope check for one record's jurisdiction, then the gating profile.
async function checkedRecordOf(
  authorized: Authorized,
  kind: SubjectKind,
  recordId: string,
  stages: readonly ProfileState[],
): Promise<
  | { readonly record: AnyRecord; readonly profile: ProfileRecord }
  | StaffActionState
> {
  const { staff, reads, provisioning } = authorized;
  const record = await visibleRecordOf(reads, kind, recordId);
  if (record === undefined) {
    return UNAVAILABLE;
  }
  if (record === null || record.attorneyId === staff.ownAttorneyId) {
    return DENIED;
  }
  const granted = await holds(reads, record.jurisdictionId);
  if (granted === null) {
    return UNAVAILABLE;
  }
  if (!granted) {
    return DENIED;
  }
  const profile = await gatingProfileOf(provisioning, record.attorneyId);
  if (profile === null) {
    return UNAVAILABLE;
  }
  if (!stages.includes(profile.state)) {
    return LOCKED;
  }
  return { record, profile };
}

function subjectKindOf(raw: string | null): SubjectKind | null {
  return isOneOf(SUBJECT_KINDS, raw) ? raw : null;
}

// Exactly one row reported by one write.
async function wroteOne(call: () => Promise<RowsResult>): Promise<boolean> {
  const rows = rowsOf(await attempt(call));
  return rows !== null && rows.length === 1;
}

// A new record id generated on the server, or null when unusable.
function newIdOf(sources: StaffSources): string | null {
  try {
    const id = sources.newId();
    return isUuid(id) ? id : null;
  } catch {
    return null;
  }
}

type Authority = {
  readonly forWrite: () => Promise<boolean | null>;
  readonly atCompletion: () => Promise<boolean | null>;
  readonly staffHolds: () => Promise<boolean | null>;
};

// A fresh re-check of the reviewer's authority for one change: the whole
// staff chain again (session, confirmed Auth read, active User, active Staff
// Profile) for the same User, the database's own scope predicate for the
// change's exact jurisdiction (null is the global scope), and the change's
// own precondition. A revoked, expired, or re-scoped grant, a deactivated
// Staff Profile, or a suspended User therefore stops every remaining write.
function staffAuthorityOf(
  sources: StaffSources,
  authorized: Authorized,
  jurisdictionId: string | null,
  precondition: () => Promise<boolean | null> = async () => true,
): Authority {
  const staffHolds = async (): Promise<boolean | null> => {
    const fresh = await staffContextOf(sources, authorized.reads);
    if (!("userId" in fresh)) {
      return fresh === UNAVAILABLE ? null : false;
    }
    if (fresh.userId !== authorized.staff.userId) {
      return false;
    }
    return await holds(authorized.reads, jurisdictionId);
  };
  return {
    forWrite: async () => {
      const held = await staffHolds();
      return held === true ? await precondition() : held;
    },
    atCompletion: staffHolds,
    staffHolds,
  };
}

// Whether the attorney's profile is still in one of the stages a change
// needs, read afresh through the privileged port.
function stageStill(
  provisioning: StaffProvisioning,
  attorneyId: string,
  stages: readonly ProfileState[],
): () => Promise<boolean | null> {
  return async () => {
    const profile = await gatingProfileOf(provisioning, attorneyId);
    return profile === null ? null : stages.includes(profile.state);
  };
}

// The fixed state shown for one audited change. Only a change whose attempt
// and applied outcome were both recorded, under authority that still held at
// completion, is reported recorded. A change stopped before any write is
// explained by a fresh re-check: lost access is denied, anything else is a
// stage or state that no longer allows it.
async function staffStateOf(
  result: AuditedResult,
  authority: Authority,
): Promise<StaffActionState> {
  if (result.status === "unrecorded") {
    return UNAVAILABLE;
  }
  if (result.status === "stopped") {
    if (result.outcome !== "not_applied") {
      return UNCONFIRMED;
    }
    if (result.authority === "unreadable") {
      return UNAVAILABLE;
    }
    const staff = await attempt(authority.staffHolds);
    return staff === true ? LOCKED : staff === false ? DENIED : UNAVAILABLE;
  }
  if (result.outcome === "not_applied") {
    return NOT_SAVED;
  }
  return result.outcome === "applied" &&
    result.authorityAtCompletion === "held" &&
    result.outcomeRecorded
    ? RECORDED
    : UNCONFIRMED;
}

// What persisted of one evidence write and its link, read by id through the
// privileged port (so a reviewer whose access just lapsed cannot make a
// persisted row look absent).
async function evidencePersisted(
  provisioning: StaffProvisioning,
  evidenceId: string,
  kind: SubjectKind,
  recordId: string,
): Promise<{ readonly evidence: boolean; readonly link: boolean } | null> {
  const [evidence, subjects] = await Promise.all([
    attempt(() => provisioning.evidenceOf([evidenceId])),
    attempt(() => provisioning.evidenceSubjectsOf(kind, [recordId])),
  ]);
  const evidenceRows = listOf(evidence, readEvidence);
  const subjectRows = listOf(subjects, readEvidenceSubject);
  if (evidenceRows === null || subjectRows === null) {
    return null;
  }
  return {
    evidence: evidenceRows.some((row) => row.id === evidenceId),
    link: subjectRows.some(
      (row) =>
        row.evidenceId === evidenceId &&
        row.kind === kind &&
        row.subjectId === recordId,
    ),
  };
}

function outcomeOfParts(parts: readonly boolean[]): AuditedOutcome {
  if (parts.every(Boolean)) {
    return "applied";
  }
  return parts.some(Boolean) ? "partially_applied" : "not_applied";
}

// One professional record by id, read afresh through the privileged port
// within its own attorney and jurisdiction.
async function persistedRecordOf(
  provisioning: StaffProvisioning,
  kind: "license" | "discipline" | "practice_area_authorisation",
  record: AnyRecord,
): Promise<AnyRecord | null | undefined> {
  const jurisdictionId = record.jurisdictionId;
  if (jurisdictionId === null) {
    return undefined;
  }
  const call =
    kind === "license"
      ? () => provisioning.licensesIn(record.attorneyId, jurisdictionId)
      : kind === "discipline"
        ? () => provisioning.disciplineIn(record.attorneyId, jurisdictionId)
        : () =>
            provisioning.authorisationsIn(record.attorneyId, jurisdictionId);
  const rows = listOf(await attempt(call), READERS[kind]);
  if (rows === null) {
    return undefined;
  }
  return rows.find((row) => row.id === record.id) ?? null;
}

// Records a source-grounded verification finding for one professional
// record: an immutable evidence row linked to that record, and, for a
// license, the status the source reported, or, for a discipline record, its
// current status. Evidence is written before any status, so a status never
// changes without the evidence that supports it.
export async function recordVerificationFinding(
  sources: StaffSources,
  formData: unknown,
): Promise<StaffActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return UNAVAILABLE;
    }
    const kind = subjectKindOf(single(formData, "subject_kind"));
    const recordId = single(formData, "record");
    if (kind === null || !isUuid(recordId)) {
      return UNAVAILABLE;
    }
    const nowMs = sources.clock();
    const collected: Collected = { errors: {} };
    const fields = evidenceFieldsOf(collected, formData, nowMs);
    const observed =
      kind === "license"
        ? optionalText(
            collected,
            formData,
            "observed_status",
            "Status reported by the source",
            40,
          )
        : null;
    const disciplineStatus =
      kind === "discipline"
        ? optionalText(
            collected,
            formData,
            "discipline_status",
            "Discipline status",
            40,
          )
        : null;
    const resolvedAt =
      kind === "discipline"
        ? optionalDay(collected, formData, "resolved_at", "Resolved date")
        : null;
    if (
      fields === null ||
      observed === undefined ||
      disciplineStatus === undefined ||
      resolvedAt === undefined ||
      Object.keys(collected.errors).length > 0
    ) {
      return invalid(collected.errors);
    }
    const authorized = await authorizedStaffOf(sources);
    if (!("staff" in authorized)) {
      return authorized;
    }
    const checked = await checkedRecordOf(
      authorized,
      kind,
      recordId,
      FINDING_STAGES,
    );
    if (!("record" in checked)) {
      return checked;
    }
    const { staff, provisioning } = authorized;
    const record = checked.record;
    const evidenceId = newIdOf(sources);
    if (evidenceId === null) {
      return UNAVAILABLE;
    }
    const statusChange =
      kind === "license" && observed !== null
        ? () =>
            wroteOne(() =>
              provisioning.recordLicenseObservation(
                record.attorneyId,
                recordId,
                record.updatedAt,
                observed,
              ),
            )
        : kind === "discipline" && disciplineStatus !== null
          ? () =>
              wroteOne(() =>
                provisioning.updateDisciplineStatus(
                  record.attorneyId,
                  recordId,
                  record.updatedAt,
                  disciplineStatus,
                  resolvedAt,
                ),
              )
          : null;
    const authority = staffAuthorityOf(
      sources,
      authorized,
      record.jurisdictionId,
      stageStill(provisioning, record.attorneyId, FINDING_STAGES),
    );
    const result = await runAuditedChange(
      {
        port: provisioning,
        attempt: {
          actorUserId: staff.userId,
          actorType: "staff",
          action: AUDIT_ACTIONS.evidenceRecorded,
          resourceType: "verification_evidence",
          resourceId: evidenceId,
          after: {
            subject_kind: kind,
            subject_id: recordId,
            discrepancy: fields.discrepancy_flag,
            observed_status: observed,
            discipline_status: disciplineStatus,
          },
          jurisdictionId: record.jurisdictionId,
          occurredAtMs: sources.clock(),
        },
        authorizedForWrite: authority.forWrite,
        authorizedAtCompletion: authority.atCompletion,
        steps: [
          () =>
            wroteOne(() =>
              provisioning.insertEvidence({
                ...fields,
                id: evidenceId,
                jurisdiction_id: record.jurisdictionId,
                retrieved_by_user_id: staff.userId,
              }),
            ),
          () =>
            wroteOne(() =>
              provisioning.linkEvidence(evidenceId, kind, recordId),
            ),
          ...(statusChange === null ? [] : [statusChange]),
        ],
        verify: async () => {
          const persisted = await evidencePersisted(
            provisioning,
            evidenceId,
            kind,
            recordId,
          );
          if (persisted === null) {
            return "unknown";
          }
          const parts = [persisted.evidence, persisted.link];
          if (statusChange !== null) {
            const fresh = await persistedRecordOf(
              provisioning,
              kind as "license" | "discipline",
              record,
            );
            if (fresh === undefined) {
              return "unknown";
            }
            parts.push(
              fresh !== null &&
                (kind === "license"
                  ? (fresh as LicenseRecord).reportedStatus === observed
                  : (fresh as DisciplineRecord).status === disciplineStatus),
            );
          }
          return outcomeOfParts(parts);
        },
      },
      sources.clock,
    );
    return await staffStateOf(result, authority);
  } catch {
    return UNAVAILABLE;
  }
}

// Records that a verification source could not be consulted. It is an audit
// event only: no evidence row, no status, and no verification. The audit row
// is itself the whole record, appended after a fresh authority re-check.
export async function recordSourceUnavailable(
  sources: StaffSources,
  formData: unknown,
): Promise<StaffActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return UNAVAILABLE;
    }
    const kind = subjectKindOf(single(formData, "subject_kind"));
    const recordId = single(formData, "record");
    if (kind === null || !isUuid(recordId)) {
      return UNAVAILABLE;
    }
    const collected: Collected = { errors: {} };
    const note = requiredText(
      collected,
      formData,
      "note",
      "What was unavailable",
      500,
    );
    if (note === null) {
      return invalid(collected.errors);
    }
    const authorized = await authorizedStaffOf(sources);
    if (!("staff" in authorized)) {
      return authorized;
    }
    const checked = await checkedRecordOf(
      authorized,
      kind,
      recordId,
      FINDING_STAGES,
    );
    if (!("record" in checked)) {
      return checked;
    }
    const authority = staffAuthorityOf(
      sources,
      authorized,
      checked.record.jurisdictionId,
    );
    const held = await attempt(authority.forWrite);
    if (held !== true) {
      return held === false ? DENIED : UNAVAILABLE;
    }
    const resourceTypes = {
      license: "license",
      insurance: "insurance_record",
      discipline: "discipline_record",
      practice_area_authorisation: "practice_area_authorisation",
    } as const;
    const rows = rowsOf(
      await attempt(() =>
        authorized.provisioning.insertAuditEvent(
          auditEventOf({
            actorUserId: authorized.staff.userId,
            actorType: "staff",
            action: AUDIT_ACTIONS.sourceUnavailable,
            resourceType: resourceTypes[kind],
            resourceId: recordId,
            after: { note },
            reasonCode: "verification_source_unavailable",
            jurisdictionId: checked.record.jurisdictionId,
            occurredAtMs: sources.clock(),
          }),
        ),
      ),
    );
    return rows !== null && rows.length === 1 ? RECORDED : UNCONFIRMED;
  } catch {
    return UNAVAILABLE;
  }
}

// Records a discipline finding from a named source: a new discipline record
// in a jurisdiction the caller holds, and the evidence it rests on.
export async function recordDisciplineFinding(
  sources: StaffSources,
  formData: unknown,
): Promise<StaffActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return UNAVAILABLE;
    }
    const attorneyId = single(formData, "attorney");
    if (!isUuid(attorneyId)) {
      return UNAVAILABLE;
    }
    const nowMs = sources.clock();
    const collected: Collected = { errors: {} };
    const jurisdictionId = single(formData, "jurisdiction_id");
    if (!isUuid(jurisdictionId)) {
      fail(
        collected,
        "jurisdiction_id",
        "Choose the jurisdiction of the record.",
      );
    }
    const externalReference = optionalText(
      collected,
      formData,
      "external_reference",
      "Regulator reference",
      120,
    );
    const findingType = optionalText(
      collected,
      formData,
      "finding_type",
      "Finding type",
      80,
    );
    const openedAt = optionalDay(
      collected,
      formData,
      "opened_at",
      "Opened date",
    );
    const resolvedAt = optionalDay(
      collected,
      formData,
      "resolved_at",
      "Resolved date",
    );
    if (
      typeof openedAt === "string" &&
      typeof resolvedAt === "string" &&
      resolvedAt < openedAt
    ) {
      fail(
        collected,
        "resolved_at",
        "Resolved date cannot be before the opened date.",
      );
    }
    const status = requiredText(
      collected,
      formData,
      "discipline_status",
      "Status reported by the source",
      40,
    );
    const fields = evidenceFieldsOf(collected, formData, nowMs);
    if (
      !isUuid(jurisdictionId) ||
      externalReference === undefined ||
      findingType === undefined ||
      openedAt === undefined ||
      resolvedAt === undefined ||
      status === null ||
      fields === null ||
      Object.keys(collected.errors).length > 0
    ) {
      return invalid(collected.errors);
    }
    const authorized = await authorizedStaffOf(sources);
    if (!("staff" in authorized)) {
      return authorized;
    }
    const { staff, reads, provisioning } = authorized;
    if (attorneyId === staff.ownAttorneyId) {
      return DENIED;
    }
    const granted = await holds(reads, jurisdictionId);
    if (granted === null) {
      return UNAVAILABLE;
    }
    if (!granted) {
      return DENIED;
    }
    const profile = await gatingProfileOf(provisioning, attorneyId);
    if (profile === null) {
      return DENIED;
    }
    if (!FINDING_STAGES.includes(profile.state)) {
      return LOCKED;
    }
    const disciplineId = newIdOf(sources);
    const evidenceId = newIdOf(sources);
    if (disciplineId === null || evidenceId === null) {
      return UNAVAILABLE;
    }
    const insert: DisciplineInsert = {
      jurisdiction_id: jurisdictionId,
      external_reference: externalReference,
      finding_type: findingType,
      opened_at: openedAt,
      resolved_at: resolvedAt,
      status,
    };
    const authority = staffAuthorityOf(
      sources,
      authorized,
      jurisdictionId,
      stageStill(provisioning, attorneyId, FINDING_STAGES),
    );
    const result = await runAuditedChange(
      {
        port: provisioning,
        attempt: {
          actorUserId: staff.userId,
          actorType: "staff",
          action: AUDIT_ACTIONS.disciplineRecorded,
          resourceType: "discipline_record",
          resourceId: disciplineId,
          after: {
            attorney_id: attorneyId,
            status,
            finding_type: findingType,
            external_reference: externalReference,
            evidence_id: evidenceId,
          },
          jurisdictionId,
          occurredAtMs: sources.clock(),
        },
        authorizedForWrite: authority.forWrite,
        authorizedAtCompletion: authority.atCompletion,
        steps: [
          () =>
            wroteOne(() =>
              provisioning.insertDiscipline(attorneyId, disciplineId, insert),
            ),
          () =>
            wroteOne(() =>
              provisioning.insertEvidence({
                ...fields,
                id: evidenceId,
                jurisdiction_id: jurisdictionId,
                retrieved_by_user_id: staff.userId,
              }),
            ),
          () =>
            wroteOne(() =>
              provisioning.linkEvidence(evidenceId, "discipline", disciplineId),
            ),
        ],
        verify: async () => {
          const rows = listOf(
            await attempt(() =>
              provisioning.disciplineIn(attorneyId, jurisdictionId),
            ),
            readDiscipline,
          );
          const persisted = await evidencePersisted(
            provisioning,
            evidenceId,
            "discipline",
            disciplineId,
          );
          if (rows === null || persisted === null) {
            return "unknown";
          }
          return outcomeOfParts([
            rows.some((row) => row.id === disciplineId),
            persisted.evidence,
            persisted.link,
          ]);
        },
      },
      sources.clock,
    );
    return await staffStateOf(result, authority);
  } catch {
    return UNAVAILABLE;
  }
}

// Decides one pending practice-area request: authorised, with an explicit
// effective start, or refused. Authorisation is not panel membership.
export async function decidePracticeArea(
  sources: StaffSources,
  formData: unknown,
): Promise<StaffActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return UNAVAILABLE;
    }
    const recordId = single(formData, "record");
    const decision = single(formData, "decision");
    if (
      !isUuid(recordId) ||
      (decision !== "authorised" && decision !== "refused")
    ) {
      return UNAVAILABLE;
    }
    const nowMs = sources.clock();
    const collected: Collected = { errors: {} };
    const note = requiredText(
      collected,
      formData,
      "note",
      "Basis for the decision",
      500,
    );
    let effectiveFrom: number | null = null;
    let effectiveUntil: number | null = null;
    if (decision === "authorised") {
      const fromRaw = single(formData, "effective_from");
      effectiveFrom = fromRaw === null ? null : dateTimeOf(fromRaw);
      if (effectiveFrom === null) {
        fail(
          collected,
          "effective_from",
          "Effective from must be a date and time (UTC).",
        );
      }
      const untilRaw = single(formData, "effective_until");
      if (untilRaw !== "") {
        effectiveUntil = untilRaw === null ? null : dateTimeOf(untilRaw);
        if (effectiveUntil === null) {
          fail(
            collected,
            "effective_until",
            "Effective until must be a date and time (UTC).",
          );
        } else if (effectiveFrom !== null && effectiveUntil < effectiveFrom) {
          fail(
            collected,
            "effective_until",
            "Effective until cannot be before effective from.",
          );
        }
      }
    }
    if (note === null || Object.keys(collected.errors).length > 0) {
      return invalid(collected.errors);
    }
    const authorized = await authorizedStaffOf(sources);
    if (!("staff" in authorized)) {
      return authorized;
    }
    const checked = await checkedRecordOf(
      authorized,
      "practice_area_authorisation",
      recordId,
      DECISION_STAGES,
    );
    if (!("record" in checked)) {
      return checked;
    }
    const entry = checked.record as PracticeAuthorisationRecord;
    if (entry.status !== "requested") {
      return LOCKED;
    }
    const { staff, provisioning } = authorized;
    const outcome: AuthorisationDecision = {
      status: decision,
      decided_at: new Date(nowMs).toISOString(),
      effective_from:
        effectiveFrom === null ? null : new Date(effectiveFrom).toISOString(),
      effective_until:
        effectiveUntil === null ? null : new Date(effectiveUntil).toISOString(),
    };
    const authority = staffAuthorityOf(
      sources,
      authorized,
      entry.jurisdictionId,
      stageStill(provisioning, entry.attorneyId, DECISION_STAGES),
    );
    const result = await runAuditedChange(
      {
        port: provisioning,
        attempt: {
          actorUserId: staff.userId,
          actorType: "staff",
          action: AUDIT_ACTIONS.practiceAreaDecided,
          resourceType: "practice_area_authorisation",
          resourceId: recordId,
          before: { status: "requested" },
          after: { ...outcome, note },
          jurisdictionId: entry.jurisdictionId,
          occurredAtMs: sources.clock(),
        },
        authorizedForWrite: authority.forWrite,
        authorizedAtCompletion: authority.atCompletion,
        steps: [
          () =>
            wroteOne(() =>
              provisioning.decideAuthorisation(
                entry.attorneyId,
                recordId,
                entry.updatedAt,
                outcome,
              ),
            ),
        ],
        verify: async () => {
          const fresh = await persistedRecordOf(
            provisioning,
            "practice_area_authorisation",
            entry,
          );
          if (fresh === undefined) {
            return "unknown";
          }
          return fresh !== null &&
            (fresh as PracticeAuthorisationRecord).status === decision
            ? "applied"
            : "not_applied";
        },
      },
      sources.clock,
    );
    return await staffStateOf(result, authority);
  } catch {
    return UNAVAILABLE;
  }
}

// Makes one supported profile review transition. It needs the global scope,
// exactly as reading another attorney's profile does.
export async function changeProfileStage(
  sources: StaffSources,
  formData: unknown,
): Promise<StaffActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return UNAVAILABLE;
    }
    const attorneyId = single(formData, "attorney");
    const intent = single(formData, "intent");
    if (!isUuid(attorneyId) || !isOneOf(REVIEW_INTENTS, intent)) {
      return UNAVAILABLE;
    }
    const collected: Collected = { errors: {} };
    // A request for information carries only its message to the applicant;
    // approval and suspension carry an optional staff-only note.
    const message =
      intent === "request_information"
        ? requiredText(
            collected,
            formData,
            "message",
            "Message to the applicant",
            1000,
          )
        : null;
    const note =
      intent === "request_information"
        ? null
        : optionalText(collected, formData, "note", "Staff note", 500);
    if (note === undefined || Object.keys(collected.errors).length > 0) {
      return invalid(collected.errors);
    }
    const authorized = await authorizedStaffOf(sources);
    if (!("staff" in authorized)) {
      return authorized;
    }
    const { staff, reads, provisioning } = authorized;
    if (attorneyId === staff.ownAttorneyId) {
      return DENIED;
    }
    const global = await holds(reads, null);
    if (global === null) {
      return UNAVAILABLE;
    }
    if (!global) {
      return DENIED;
    }
    const visible = listOf(
      await attempt(() => reads.attorneyProfileById(attorneyId)),
      readProfile,
    );
    if (visible === null || visible.length > 1) {
      return UNAVAILABLE;
    }
    if (visible.length === 0 || visible[0].id !== attorneyId) {
      return DENIED;
    }
    const transition = TRANSITIONS[intent];
    if (visible[0].state !== transition.from) {
      return LOCKED;
    }
    const authority = staffAuthorityOf(sources, authorized, null);
    const result = await runAuditedChange(
      {
        port: provisioning,
        attempt: {
          actorUserId: staff.userId,
          actorType: "staff",
          action:
            intent === "request_information"
              ? AUDIT_ACTIONS.informationRequested
              : AUDIT_ACTIONS.profileStateChanged,
          resourceType: "attorney_profile",
          resourceId: attorneyId,
          before: { profile_state: transition.from },
          after:
            intent === "request_information"
              ? { profile_state: transition.to, message_to_applicant: message }
              : { profile_state: transition.to, staff_note: note },
          reasonCode: `staff_review_${intent}`,
          occurredAtMs: sources.clock(),
        },
        authorizedForWrite: authority.forWrite,
        authorizedAtCompletion: authority.atCompletion,
        steps: [
          () =>
            wroteOne(() =>
              provisioning.transitionProfile(attorneyId, transition),
            ),
        ],
        verify: async () => {
          const fresh = await gatingProfileOf(provisioning, attorneyId);
          if (fresh === null) {
            return "unknown";
          }
          return fresh.state === transition.to ? "applied" : "not_applied";
        },
      },
      sources.clock,
    );
    return await staffStateOf(result, authority);
  } catch {
    return UNAVAILABLE;
  }
}

// Records one consequential Eligibility determination: the current
// assessment for one attorney in one jurisdiction the caller holds,
// optionally for one practice area, persisted as a new immutable evaluation.
// Earlier evaluations are never changed.
export async function recordEligibilityDetermination(
  sources: StaffSources,
  formData: unknown,
): Promise<StaffActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return UNAVAILABLE;
    }
    const attorneyId = single(formData, "attorney");
    const jurisdictionId = single(formData, "jurisdiction_id");
    const practiceRaw = single(formData, "practice_area_id");
    if (
      !isUuid(attorneyId) ||
      !isUuid(jurisdictionId) ||
      practiceRaw === null
    ) {
      return UNAVAILABLE;
    }
    const practiceAreaId = practiceRaw === "" ? null : practiceRaw;
    if (practiceAreaId !== null && !isUuid(practiceAreaId)) {
      return invalid({ practice_area_id: ["Choose a practice area or none."] });
    }
    const authorized = await authorizedStaffOf(sources);
    if (!("staff" in authorized)) {
      return authorized;
    }
    const { staff, reads, provisioning } = authorized;
    if (attorneyId === staff.ownAttorneyId) {
      return DENIED;
    }
    const granted = await holds(reads, jurisdictionId);
    if (granted === null) {
      return UNAVAILABLE;
    }
    if (!granted) {
      return DENIED;
    }
    if (practiceAreaId !== null) {
      const areas = listOf(
        await attempt(() => reads.practiceAreas()),
        readPracticeArea,
      );
      if (areas === null) {
        return UNAVAILABLE;
      }
      if (!areas.some((area) => area.id === practiceAreaId)) {
        return invalid({
          practice_area_id: ["Choose a practice area or none."],
        });
      }
    }
    const profile = await gatingProfileOf(provisioning, attorneyId);
    if (profile === null) {
      return DENIED;
    }
    const evaluationId = newIdOf(sources);
    if (evaluationId === null) {
      return UNAVAILABLE;
    }
    const asOfMs = sources.clock();
    const assessment = await assessmentOf(
      provisioning,
      attorneyId,
      jurisdictionId,
      practiceAreaId,
      asOfMs,
    );
    const evaluated = evaluationRowOf(assessment, asOfMs);
    if (evaluated === null) {
      return UNAVAILABLE;
    }
    const row = Object.freeze({ id: evaluationId, ...evaluated });
    const authority = staffAuthorityOf(sources, authorized, jurisdictionId);
    const result = await runAuditedChange(
      {
        port: provisioning,
        attempt: {
          actorUserId: staff.userId,
          actorType: "staff",
          action: AUDIT_ACTIONS.eligibilityRecorded,
          resourceType: "eligibility_evaluation",
          resourceId: evaluationId,
          after: {
            result: assessment.result,
            attorney_id: attorneyId,
            practice_area_id: practiceAreaId,
            as_of: assessment.asOf,
          },
          policyReferences: assessment.policyReferences,
          jurisdictionId,
          occurredAtMs: sources.clock(),
        },
        authorizedForWrite: authority.forWrite,
        authorizedAtCompletion: authority.atCompletion,
        steps: [() => wroteOne(() => provisioning.insertEvaluation(row))],
        verify: async () => {
          const rows = listOf(
            await attempt(() => provisioning.evaluationById(evaluationId)),
            readEvaluation,
          );
          if (rows === null) {
            return "unknown";
          }
          return rows.some(
            (e) =>
              e.id === evaluationId &&
              e.attorneyId === attorneyId &&
              e.result === assessment.result,
          )
            ? "applied"
            : "not_applied";
        },
      },
      sources.clock,
    );
    return await staffStateOf(result, authority);
  } catch {
    return UNAVAILABLE;
  }
}
