// Attorney professional setup (P3-003).
//
// Provider-neutral and injectable: each request hands in its own ports. For
// every read and every change it establishes afresh, on the server, the
// trusted session subject, a fresh Auth read of that account with a confirmed
// email, the account's one active Rosuno User, and that User's own Attorney
// Profile. Nothing the browser sends chooses an identity, User, profile,
// lifecycle stage, verification status, or authority: a submitted record id
// only names which of the attorney's own records to change, and every write
// is keyed by the verified profile as well.
//
// What an attorney submits here are claims and requests, never findings.
// Claims are kept apart from verification evidence and from the
// source-observed license status, which only review staff record. Claims can
// be added or revised only while the profile is in the applicant stage and
// only while no verification evidence is linked to the record, so a
// relied-upon record is never rewritten. Submitting asks for review
// (applicant to under_review) and approves nothing. The readiness view keeps
// account access, the profile lifecycle stage, verification evidence status,
// recorded Eligibility determinations, and marketplace and scheduling
// readiness apart; this page becomes the source of none of them.

import {
  auditEventOf,
  AUDIT_ACTIONS,
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
  isDate,
  isOneOf,
  isTimestamp,
  isUuid,
  readExact,
  readInsurance,
  readJurisdiction,
  readLicense,
  readPracticeArea,
  readPracticeAuthorisation,
  readProfile,
  readRows,
  type InsuranceRecord,
  type LicenseRecord,
  type PracticeAuthorisationRecord,
  type ProfileRecord,
  type ProfileState,
  type SubjectKind,
} from "./professional-records.ts";
import type { ServerSessionSource } from "./session.ts";

// Request-scoped, unprivileged reads under the database's own-row policies,
// keyed only by the verified account, User, and profile.
export type AttorneyProfessionalReads = {
  readonly usersOf: (accountId: string) => Promise<RowsResult>;
  readonly profilesOf: (userId: string) => Promise<RowsResult>;
  readonly licensesOf: (attorneyId: string) => Promise<RowsResult>;
  readonly insuranceOf: (attorneyId: string) => Promise<RowsResult>;
  readonly authorisationsOf: (attorneyId: string) => Promise<RowsResult>;
  readonly practiceAreas: () => Promise<RowsResult>;
};

export type ProfileDetails = {
  readonly display_name: string | null;
  readonly headline: string | null;
  readonly bio: string | null;
  readonly years_experience: number | null;
};

export type LicenseClaim = {
  readonly jurisdiction_id: string;
  readonly license_number: string;
  readonly license_type: string | null;
  readonly effective_from: string | null;
  readonly effective_until: string | null;
};

export type InsuranceClaim = {
  readonly jurisdiction_id: string;
  readonly carrier_name: string;
  readonly policy_reference: string | null;
  readonly coverage_type: string | null;
  readonly per_occurrence_limit_minor: number | null;
  readonly aggregate_limit_minor: number | null;
  readonly currency_code: string | null;
  readonly coverage_from: string | null;
  readonly coverage_until: string | null;
};

// Server-only, privileged port with narrow, exact-key operations. Every
// write names the verified profile; none takes a lifecycle stage, verified
// status, observed status, or decision from the caller.
export type AttorneyProfessionalProvisioning = {
  readonly jurisdictions: () => Promise<RowsResult>;
  readonly evidenceSubjectsOf: (
    kind: SubjectKind,
    recordIds: readonly string[],
  ) => Promise<RowsResult>;
  readonly evidenceFlagsOf: (
    evidenceIds: readonly string[],
  ) => Promise<RowsResult>;
  readonly evaluationsOf: (attorneyId: string) => Promise<RowsResult>;
  readonly informationRequestsOf: (attorneyId: string) => Promise<RowsResult>;
  readonly updateProfileDetails: (
    attorneyId: string,
    userId: string,
    details: ProfileDetails,
  ) => Promise<RowsResult>;
  readonly insertLicense: (
    attorneyId: string,
    claim: LicenseClaim,
  ) => Promise<RowsResult>;
  readonly updateLicense: (
    attorneyId: string,
    licenseId: string,
    expectedUpdatedAt: string,
    claim: LicenseClaim,
  ) => Promise<RowsResult>;
  readonly insertInsurance: (
    attorneyId: string,
    claim: InsuranceClaim,
  ) => Promise<RowsResult>;
  readonly updateInsurance: (
    attorneyId: string,
    recordId: string,
    expectedUpdatedAt: string,
    claim: InsuranceClaim,
  ) => Promise<RowsResult>;
  readonly insertAuthorisationRequest: (
    attorneyId: string,
    jurisdictionId: string,
    practiceAreaId: string,
    requestedAt: string,
  ) => Promise<RowsResult>;
  readonly updateAuthorisationRequest: (
    attorneyId: string,
    authorisationId: string,
    expectedStatus: "requested" | "withdrawn",
    expectedUpdatedAt: string,
    next:
      | { readonly status: "withdrawn" }
      | { readonly status: "requested"; readonly requestedAt: string },
  ) => Promise<RowsResult>;
  readonly submitApplication: (
    attorneyId: string,
    userId: string,
  ) => Promise<RowsResult>;
  readonly insertAuditEvent: (event: AuditEvent) => Promise<RowsResult>;
};

export type AttorneyProfessionalSources = {
  readonly session: ServerSessionSource;
  readonly account: AccountSource;
  readonly reads: () => Promise<AttorneyProfessionalReads | null>;
  readonly provisioning: () => Promise<AttorneyProfessionalProvisioning | null>;
  readonly clock: () => number;
};

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

export type ClaimVerification =
  "awaiting_review" | "source_checked" | "needs_attention";

export type LicenseView = {
  readonly id: string;
  readonly jurisdictionId: string;
  readonly jurisdiction: string;
  readonly licenseNumber: string;
  readonly licenseType: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string;
  // The status the licensing source reported to review staff, if any.
  readonly observedStatus: string | null;
  readonly verification: ClaimVerification;
  readonly editable: boolean;
};

export type InsuranceView = {
  readonly id: string;
  readonly jurisdictionId: string;
  readonly jurisdiction: string;
  readonly carrierName: string;
  readonly policyReference: string;
  readonly coverageType: string;
  readonly perOccurrenceLimitMinor: string;
  readonly aggregateLimitMinor: string;
  readonly currencyCode: string;
  readonly coverageFrom: string;
  readonly coverageUntil: string;
  readonly verification: ClaimVerification;
  readonly editable: boolean;
};

export type AuthorisationView = {
  readonly id: string;
  readonly jurisdiction: string;
  readonly practiceArea: string;
  readonly status:
    "requested" | "withdrawn" | "authorised" | "refused" | "other";
  readonly canWithdraw: boolean;
  readonly canRenew: boolean;
};

export type EligibilityView = {
  readonly jurisdiction: string;
  readonly context: string;
  readonly result: "eligible" | "not_eligible" | "undetermined" | "other";
  readonly evaluatedAt: string;
};

export type InformationRequestView = {
  readonly requestedAt: string;
  readonly message: string;
};

export type Option = { readonly value: string; readonly label: string };

export type ProfessionalSetupView =
  | typeof SIGN_IN_REQUIRED
  | typeof DENIED
  | typeof UNAVAILABLE
  | { readonly status: "no-application" }
  | {
      readonly status: "ready";
      readonly stage: ProfileState;
      readonly editable: boolean;
      readonly canSubmit: boolean;
      readonly details: {
        readonly displayName: string;
        readonly headline: string;
        readonly bio: string;
        readonly yearsExperience: string;
      };
      readonly licenses: readonly LicenseView[];
      readonly insurance: readonly InsuranceView[];
      readonly authorisations: readonly AuthorisationView[];
      readonly eligibility: readonly EligibilityView[];
      readonly informationRequests: readonly InformationRequestView[];
      readonly jurisdictions: readonly Option[];
      readonly practiceAreas: readonly Option[];
    };

const NO_APPLICATION = Object.freeze({ status: "no-application" } as const);

type AttorneyContext = {
  readonly userId: string;
  readonly profile: ProfileRecord;
};

// The verified attorney context of the request, or a fixed refusal. The
// profile is read only by the verified User id; a suspended or removed
// profile is denied here and never revived.
async function attorneyContextOf(
  sources: AttorneyProfessionalSources,
  reads: AttorneyProfessionalReads,
): Promise<AttorneyContext | Refusal | typeof NO_APPLICATION> {
  const account = await confirmedAccountOf(sources.session, sources.account);
  if (!("accountId" in account)) {
    return account;
  }
  const user = await activeUserOf(reads.usersOf, account.accountId);
  if (!("userId" in user)) {
    return user;
  }
  const profiles = rowsOf(await attempt(() => reads.profilesOf(user.userId)));
  if (profiles === null || profiles.length > 1) {
    return UNAVAILABLE;
  }
  if (profiles.length === 0) {
    return NO_APPLICATION;
  }
  const profile = readProfile(profiles[0]);
  if (profile === null || profile.userId !== user.userId) {
    return UNAVAILABLE;
  }
  if (profile.state === "suspended" || profile.state === "removed") {
    return DENIED;
  }
  return { userId: user.userId, profile };
}

// Every row of a read, each owned by exactly this profile, or null.
function ownedRows<T extends { readonly attorneyId: string }>(
  result: unknown,
  reader: (row: unknown) => T | null,
  attorneyId: string,
): readonly T[] | null {
  const rows = rowsOf(result);
  if (rows === null) {
    return null;
  }
  const read = readRows(rows, reader);
  if (read === null || read.some((row) => row.attorneyId !== attorneyId)) {
    return null;
  }
  return read;
}

type EvidenceFlags = ReadonlyMap<string, ClaimVerification>;

// The verification status of each record from its linked evidence: none is
// awaiting review; the latest without a discrepancy is source checked; the
// latest with one needs attention. Only flags and times are read, never the
// evidence content or reviewer notes.
async function evidenceStatusOf(
  provisioning: AttorneyProfessionalProvisioning,
  kind: SubjectKind,
  recordIds: readonly string[],
): Promise<EvidenceFlags | null> {
  if (recordIds.length === 0) {
    return new Map();
  }
  const subjects = rowsOf(
    await attempt(() => provisioning.evidenceSubjectsOf(kind, recordIds)),
  );
  if (subjects === null) {
    return null;
  }
  const column = {
    license: "license_id",
    insurance: "insurance_record_id",
    discipline: "discipline_record_id",
    practice_area_authorisation: "practice_area_authorisation_id",
  }[kind];
  const links: { readonly evidenceId: string; readonly recordId: string }[] =
    [];
  for (const row of subjects) {
    const fields = readExact(row, ["verification_evidence_id", column]);
    const evidenceId = fields?.get("verification_evidence_id");
    const recordId = fields?.get(column);
    if (
      !isUuid(evidenceId) ||
      !isUuid(recordId) ||
      !recordIds.includes(recordId)
    ) {
      return null;
    }
    links.push({ evidenceId, recordId });
  }
  const statuses = new Map<string, ClaimVerification>();
  if (links.length === 0) {
    return statuses;
  }
  const flags = rowsOf(
    await attempt(() =>
      provisioning.evidenceFlagsOf([
        ...new Set(links.map((link) => link.evidenceId)),
      ]),
    ),
  );
  if (flags === null) {
    return null;
  }
  const byId = new Map<string, { at: number; discrepancy: boolean }>();
  for (const row of flags) {
    const fields = readExact(row, ["id", "discrepancy_flag", "retrieved_at"]);
    const id = fields?.get("id");
    const discrepancy = fields?.get("discrepancy_flag");
    const at = fields?.get("retrieved_at");
    if (!isUuid(id) || typeof discrepancy !== "boolean" || !isTimestamp(at)) {
      return null;
    }
    byId.set(id, { at: Date.parse(at), discrepancy });
  }
  const latest = new Map<string, { at: number; discrepancy: boolean }>();
  for (const link of links) {
    const flag = byId.get(link.evidenceId);
    if (flag === undefined) {
      return null;
    }
    const current = latest.get(link.recordId);
    if (current === undefined || flag.at >= current.at) {
      latest.set(link.recordId, flag);
    }
  }
  for (const [recordId, flag] of latest) {
    statuses.set(
      recordId,
      flag.discrepancy ? "needs_attention" : "source_checked",
    );
  }
  return statuses;
}

function labelOf(
  options: ReadonlyMap<string, string>,
  id: string | null,
): string {
  if (id === null) {
    return "Not stated";
  }
  return options.get(id) ?? "Unavailable";
}

function shown(value: string | number | null): string {
  return value === null ? "" : String(value);
}

const EVALUATION_COLUMNS_SHOWN = [
  "id",
  "jurisdiction_id",
  "context_type",
  "context_id",
  "result",
  "evaluated_at",
];

// The latest recorded determination per jurisdiction and context, as a
// coarse result only.
function eligibilityViewsOf(
  rows: readonly unknown[],
  jurisdictions: ReadonlyMap<string, string>,
  practiceAreas: ReadonlyMap<string, string>,
): readonly EligibilityView[] | null {
  const latest = new Map<string, { at: number; view: EligibilityView }>();
  for (const row of rows) {
    const fields = readExact(row, EVALUATION_COLUMNS_SHOWN);
    const jurisdictionId = fields?.get("jurisdiction_id");
    const contextType = fields?.get("context_type");
    const contextId = fields?.get("context_id");
    const result = fields?.get("result");
    const at = fields?.get("evaluated_at");
    if (
      !isUuid(fields?.get("id")) ||
      !isUuid(jurisdictionId) ||
      typeof contextType !== "string" ||
      !(contextId === null || isUuid(contextId)) ||
      typeof result !== "string" ||
      !isTimestamp(at)
    ) {
      return null;
    }
    const key = `${jurisdictionId}|${contextType}|${contextId ?? ""}`;
    const view: EligibilityView = Object.freeze({
      jurisdiction: labelOf(jurisdictions, jurisdictionId),
      context:
        contextType === "practice_area" && contextId !== null
          ? labelOf(practiceAreas, contextId)
          : "Jurisdiction",
      result: isOneOf(
        ["eligible", "not_eligible", "undetermined"] as const,
        result,
      )
        ? result
        : "other",
      evaluatedAt: at,
    });
    const current = latest.get(key);
    if (current === undefined || Date.parse(at) >= current.at) {
      latest.set(key, { at: Date.parse(at), view });
    }
  }
  return Object.freeze([...latest.values()].map((entry) => entry.view));
}

function informationRequestsOf(
  rows: readonly unknown[],
): readonly InformationRequestView[] | null {
  const views: { at: number; view: InformationRequestView }[] = [];
  for (const row of rows) {
    const fields = readExact(row, ["occurred_at", "after_snapshot"]);
    const at = fields?.get("occurred_at");
    if (fields === null || !isTimestamp(at)) {
      return null;
    }
    // Only the message written for the applicant is ever shown; a request
    // without one shows nothing, and no other snapshot field is read.
    const snapshot = fields.get("after_snapshot");
    const descriptor =
      snapshot !== null &&
      typeof snapshot === "object" &&
      !Array.isArray(snapshot)
        ? Object.getOwnPropertyDescriptor(snapshot, "message_to_applicant")
        : undefined;
    const message =
      descriptor !== undefined && "value" in descriptor
        ? descriptor.value
        : undefined;
    if (typeof message !== "string" || message.trim() === "") {
      continue;
    }
    views.push({
      at: Date.parse(at),
      view: Object.freeze({ requestedAt: at, message }),
    });
  }
  return Object.freeze(
    views.sort((a, b) => b.at - a.at).map((entry) => entry.view),
  );
}

function authorisationStatusOf(status: string): AuthorisationView["status"] {
  return isOneOf(
    ["requested", "withdrawn", "authorised", "refused"] as const,
    status,
  )
    ? status
    : "other";
}

// Resolves the professional setup page for the current request. It only
// reads, never persists an evaluation, and never throws.
export async function resolveProfessionalSetup(
  sources: AttorneyProfessionalSources,
): Promise<ProfessionalSetupView> {
  try {
    const reads = await portFrom(sources.reads);
    if (reads === null) {
      return UNAVAILABLE;
    }
    const context = await attorneyContextOf(sources, reads);
    if (!("profile" in context)) {
      return context;
    }
    // Without the trusted write boundary nothing on this page could be
    // saved, so no form is offered at all.
    const provisioning = await portFrom(sources.provisioning);
    if (provisioning === null) {
      return UNAVAILABLE;
    }
    const profile = context.profile;
    const [licenseRows, insuranceRows, authorisationRows, areaRows, jurRows] =
      await Promise.all([
        attempt(() => reads.licensesOf(profile.id)),
        attempt(() => reads.insuranceOf(profile.id)),
        attempt(() => reads.authorisationsOf(profile.id)),
        attempt(() => reads.practiceAreas()),
        attempt(() => provisioning.jurisdictions()),
      ]);
    const licenses = ownedRows(licenseRows, readLicense, profile.id);
    const insurance = ownedRows(insuranceRows, readInsurance, profile.id);
    const authorisations = ownedRows(
      authorisationRows,
      readPracticeAuthorisation,
      profile.id,
    );
    const areaList = rowsOf(areaRows);
    const jurList = rowsOf(jurRows);
    const areas =
      areaList === null ? null : readRows(areaList, readPracticeArea);
    const jurisdictions =
      jurList === null ? null : readRows(jurList, readJurisdiction);
    if (
      licenses === null ||
      insurance === null ||
      authorisations === null ||
      areas === null ||
      jurisdictions === null
    ) {
      return UNAVAILABLE;
    }
    const [licenseFlags, insuranceFlags, evaluationRows, requestRows] =
      await Promise.all([
        evidenceStatusOf(
          provisioning,
          "license",
          licenses.map((r) => r.id),
        ),
        evidenceStatusOf(
          provisioning,
          "insurance",
          insurance.map((r) => r.id),
        ),
        attempt(() => provisioning.evaluationsOf(profile.id)),
        attempt(() => provisioning.informationRequestsOf(profile.id)),
      ]);
    const evaluations = rowsOf(evaluationRows);
    const requests = rowsOf(requestRows);
    if (
      licenseFlags === null ||
      insuranceFlags === null ||
      evaluations === null ||
      requests === null
    ) {
      return UNAVAILABLE;
    }
    const jurisdictionNames = new Map(
      jurisdictions.map((j) => [j.id, `${j.name} (${j.code})`]),
    );
    const areaNames = new Map(areas.map((a) => [a.id, a.name]));
    const eligibility = eligibilityViewsOf(
      evaluations,
      jurisdictionNames,
      areaNames,
    );
    const informationRequests = informationRequestsOf(requests);
    if (eligibility === null || informationRequests === null) {
      return UNAVAILABLE;
    }
    const editable = profile.state === "applicant";
    return Object.freeze({
      status: "ready",
      stage: profile.state,
      editable,
      canSubmit: editable && licenses.length > 0,
      details: Object.freeze({
        displayName: shown(profile.displayName),
        headline: shown(profile.headline),
        bio: shown(profile.bio),
        yearsExperience: shown(profile.yearsExperience),
      }),
      licenses: Object.freeze(
        licenses.map((license) => {
          const verification =
            licenseFlags.get(license.id) ?? "awaiting_review";
          return Object.freeze({
            id: license.id,
            jurisdictionId: license.jurisdictionId,
            jurisdiction: labelOf(jurisdictionNames, license.jurisdictionId),
            licenseNumber: license.licenseNumber,
            licenseType: shown(license.licenseType),
            effectiveFrom: shown(license.effectiveFrom),
            effectiveUntil: shown(license.effectiveUntil),
            observedStatus: license.reportedStatus,
            verification,
            editable:
              editable &&
              verification === "awaiting_review" &&
              license.reportedStatus === null,
          });
        }),
      ),
      insurance: Object.freeze(
        insurance.map((record) => {
          const verification =
            insuranceFlags.get(record.id) ?? "awaiting_review";
          return Object.freeze({
            id: record.id,
            jurisdictionId: record.jurisdictionId ?? "",
            jurisdiction: labelOf(jurisdictionNames, record.jurisdictionId),
            carrierName: shown(record.carrierName),
            policyReference: shown(record.policyReference),
            coverageType: shown(record.coverageType),
            perOccurrenceLimitMinor: shown(record.perOccurrenceLimitMinor),
            aggregateLimitMinor: shown(record.aggregateLimitMinor),
            currencyCode: shown(record.currencyCode),
            coverageFrom: shown(record.coverageFrom),
            coverageUntil: shown(record.coverageUntil),
            verification,
            editable: editable && verification === "awaiting_review",
          });
        }),
      ),
      authorisations: Object.freeze(
        authorisations.map((entry) => {
          const status = authorisationStatusOf(entry.status);
          return Object.freeze({
            id: entry.id,
            jurisdiction: labelOf(jurisdictionNames, entry.jurisdictionId),
            practiceArea: labelOf(areaNames, entry.practiceAreaId),
            status,
            canWithdraw: editable && status === "requested",
            canRenew: editable && status === "withdrawn",
          });
        }),
      ),
      eligibility,
      informationRequests,
      jurisdictions: Object.freeze(
        jurisdictions.map((j) =>
          Object.freeze({ value: j.id, label: `${j.name} (${j.code})` }),
        ),
      ),
      practiceAreas: Object.freeze(
        areas
          .filter((area) => area.active)
          .map((area) => Object.freeze({ value: area.id, label: area.name })),
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

// "saved": a fresh read shows the change. "locked": the profile stage or
// the record's review status no longer allows it. "not-saved": nothing was
// changed. "unconfirmed": a write was attempted and could not be shown
// complete, so nothing is claimed.
export type ProfessionalActionState =
  | { readonly status: "idle" }
  | { readonly status: "saved" }
  | { readonly status: "invalid"; readonly fieldErrors: FieldErrors }
  | { readonly status: "locked" }
  | { readonly status: "not-saved" }
  | { readonly status: "unconfirmed" }
  | typeof SIGN_IN_REQUIRED
  | typeof DENIED
  | typeof UNAVAILABLE;

export const INITIAL_PROFESSIONAL_STATE: ProfessionalActionState =
  Object.freeze({ status: "idle" });

const SAVED = Object.freeze({ status: "saved" } as const);
const LOCKED = Object.freeze({ status: "locked" } as const);
const NOT_SAVED = Object.freeze({ status: "not-saved" } as const);
const UNCONFIRMED = Object.freeze({ status: "unconfirmed" } as const);

function invalid(
  fieldErrors: Record<string, string[]>,
): ProfessionalActionState {
  const copy: Record<string, readonly string[]> = {};
  for (const [field, messages] of Object.entries(fieldErrors)) {
    copy[field] = Object.freeze([...messages]);
  }
  return Object.freeze({ status: "invalid", fieldErrors: Object.freeze(copy) });
}

// One string field submitted exactly once, "" when absent, or null when it
// is repeated or a file.
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

function required(
  collected: Collected,
  formData: FormData,
  field: string,
  label: string,
  maxLength: number,
): string | null {
  const raw = single(formData, field);
  const value = raw === null ? null : textField(raw, maxLength);
  if (value === null) {
    return fail(
      collected,
      field,
      `${label} must be ${maxLength} characters or fewer.`,
    );
  }
  if (value === "") {
    return fail(collected, field, `Enter ${label.toLowerCase()}.`);
  }
  return value;
}

function optional(
  collected: Collected,
  formData: FormData,
  field: string,
  label: string,
  maxLength: number,
): string | null | undefined {
  const raw = single(formData, field);
  const value = raw === null ? null : textField(raw, maxLength);
  if (value === null) {
    fail(
      collected,
      field,
      `${label} must be ${maxLength} characters or fewer.`,
    );
    return undefined;
  }
  return value === "" ? null : value;
}

function optionalDate(
  collected: Collected,
  formData: FormData,
  field: string,
  label: string,
): string | null | undefined {
  const raw = single(formData, field);
  if (raw === "") {
    return null;
  }
  if (raw === null || !isDate(raw.trim())) {
    fail(collected, field, `${label} must be a real date.`);
    return undefined;
  }
  return raw.trim();
}

function optionalCount(
  collected: Collected,
  formData: FormData,
  field: string,
  label: string,
  max: number,
): number | null | undefined {
  const raw = single(formData, field);
  if (raw === "") {
    return null;
  }
  const trimmed = raw?.trim() ?? "";
  if (!/^\d{1,15}$/.test(trimmed) || Number(trimmed) > max) {
    fail(collected, field, `${label} must be a whole number from 0 to ${max}.`);
    return undefined;
  }
  return Number(trimmed);
}

function choice(
  collected: Collected,
  formData: FormData,
  field: string,
  label: string,
  allowed: readonly string[],
): string | null {
  const raw = single(formData, field);
  if (raw === null || !allowed.includes(raw)) {
    return fail(collected, field, `Choose ${label.toLowerCase()}.`);
  }
  return raw;
}

function recordIdOf(formData: FormData): string | null {
  const raw = single(formData, "record");
  return raw !== null && isUuid(raw) ? raw : null;
}

type Writable = {
  readonly context: AttorneyContext;
  readonly reads: AttorneyProfessionalReads;
  readonly provisioning: AttorneyProfessionalProvisioning;
};

// The verified context of a change: the attorney's own profile, still in the
// applicant stage, and both ports. Anything else refuses before any write.
async function writableOf(
  sources: AttorneyProfessionalSources,
): Promise<Writable | ProfessionalActionState> {
  const reads = await portFrom(sources.reads);
  if (reads === null) {
    return UNAVAILABLE;
  }
  const context = await attorneyContextOf(sources, reads);
  if (!("profile" in context)) {
    return context.status === "no-application" ? DENIED : context;
  }
  if (context.profile.state !== "applicant") {
    return LOCKED;
  }
  const provisioning = await portFrom(sources.provisioning);
  if (provisioning === null) {
    return UNAVAILABLE;
  }
  return { context, reads, provisioning };
}

// The jurisdiction and practice-area options a submission may name, read
// afresh from the trusted configuration.
async function jurisdictionIdsOf(
  provisioning: AttorneyProfessionalProvisioning,
): Promise<readonly string[] | null> {
  const rows = rowsOf(await attempt(() => provisioning.jurisdictions()));
  const read = rows === null ? null : readRows(rows, readJurisdiction);
  return read === null ? null : read.map((j) => j.id);
}

async function activePracticeAreaIdsOf(
  reads: AttorneyProfessionalReads,
): Promise<readonly string[] | null> {
  const rows = rowsOf(await attempt(() => reads.practiceAreas()));
  const read = rows === null ? null : readRows(rows, readPracticeArea);
  return read === null
    ? null
    : read.filter((area) => area.active).map((area) => area.id);
}

// Records the audit event of a change that a fresh read already showed. A
// missing audit row is reported as unconfirmed, never as saved.
async function audited(
  provisioning: AttorneyProfessionalProvisioning,
  event: AuditEvent,
): Promise<ProfessionalActionState> {
  const rows = rowsOf(
    await attempt(() => provisioning.insertAuditEvent(event)),
  );
  return rows !== null && rows.length === 1 ? SAVED : UNCONFIRMED;
}

function rowCountOf(result: unknown): number | null {
  const rows = rowsOf(result);
  return rows === null ? null : rows.length;
}

function claimSnapshotOfLicense(record: LicenseRecord | LicenseClaim) {
  if ("licenseNumber" in record) {
    return {
      jurisdiction_id: record.jurisdictionId,
      license_number: record.licenseNumber,
      license_type: record.licenseType,
      effective_from: record.effectiveFrom,
      effective_until: record.effectiveUntil,
    };
  }
  return { ...record };
}

function claimSnapshotOfInsurance(record: InsuranceRecord | InsuranceClaim) {
  if ("carrierName" in record) {
    return {
      jurisdiction_id: record.jurisdictionId,
      carrier_name: record.carrierName,
      policy_reference: record.policyReference,
      coverage_type: record.coverageType,
      per_occurrence_limit_minor: record.perOccurrenceLimitMinor,
      aggregate_limit_minor: record.aggregateLimitMinor,
      currency_code: record.currencyCode,
      coverage_from: record.coverageFrom,
      coverage_until: record.coverageUntil,
    };
  }
  return { ...record };
}

// Saves the attorney's own ordinary profile details. Only display name,
// headline, biography, and years of experience can change; nothing else.
export async function saveProfileDetails(
  sources: AttorneyProfessionalSources,
  formData: unknown,
): Promise<ProfessionalActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return UNAVAILABLE;
    }
    const collected: Collected = { errors: {} };
    const displayName = optional(
      collected,
      formData,
      "display_name",
      "Display name",
      120,
    );
    const headline = optional(collected, formData, "headline", "Headline", 160);
    const bio = optional(collected, formData, "bio", "Biography", 2000);
    const years = optionalCount(
      collected,
      formData,
      "years_experience",
      "Years of experience",
      80,
    );
    if (
      Object.keys(collected.errors).length > 0 ||
      displayName === undefined ||
      headline === undefined ||
      bio === undefined ||
      years === undefined
    ) {
      return invalid(collected.errors);
    }
    const writable = await writableOf(sources);
    if (!("context" in writable)) {
      return writable;
    }
    const { context, reads, provisioning } = writable;
    const details: ProfileDetails = Object.freeze({
      display_name: displayName,
      headline,
      bio,
      years_experience: years,
    });
    const count = rowCountOf(
      await attempt(() =>
        provisioning.updateProfileDetails(
          context.profile.id,
          context.userId,
          details,
        ),
      ),
    );
    const fresh = await attorneyContextOf(sources, reads);
    if (!("profile" in fresh)) {
      return UNCONFIRMED;
    }
    const after = fresh.profile;
    const matches =
      after.displayName === details.display_name &&
      after.headline === details.headline &&
      after.bio === details.bio &&
      after.yearsExperience === details.years_experience;
    if (!matches) {
      if (count === 0 && after.state !== "applicant") {
        return LOCKED;
      }
      return count === 0 ? NOT_SAVED : UNCONFIRMED;
    }
    return await audited(
      provisioning,
      auditEventOf({
        actorUserId: context.userId,
        actorType: "attorney",
        action: AUDIT_ACTIONS.profileDetailsRevised,
        resourceType: "attorney_profile",
        resourceId: context.profile.id,
        before: {
          display_name: context.profile.displayName,
          headline: context.profile.headline,
          bio: context.profile.bio,
          years_experience: context.profile.yearsExperience,
        },
        after: details,
        occurredAtMs: sources.clock(),
      }),
    );
  } catch {
    return UNAVAILABLE;
  }
}

function licenseClaimOf(
  formData: FormData,
  jurisdictions: readonly string[],
): LicenseClaim | ProfessionalActionState {
  const collected: Collected = { errors: {} };
  const jurisdiction = choice(
    collected,
    formData,
    "jurisdiction_id",
    "Licensing jurisdiction",
    jurisdictions,
  );
  const number = required(
    collected,
    formData,
    "license_number",
    "License number",
    64,
  );
  const type = optional(
    collected,
    formData,
    "license_type",
    "License type",
    80,
  );
  const from = optionalDate(
    collected,
    formData,
    "effective_from",
    "Admission or effective date",
  );
  const until = optionalDate(
    collected,
    formData,
    "effective_until",
    "Expiry date",
  );
  if (typeof from === "string" && typeof until === "string" && until < from) {
    fail(
      collected,
      "effective_until",
      "Expiry date cannot be before the effective date.",
    );
  }
  if (
    Object.keys(collected.errors).length > 0 ||
    jurisdiction === null ||
    number === null ||
    type === undefined ||
    from === undefined ||
    until === undefined
  ) {
    return invalid(collected.errors);
  }
  return Object.freeze({
    jurisdiction_id: jurisdiction,
    license_number: number,
    license_type: type,
    effective_from: from,
    effective_until: until,
  });
}

function sameLicense(record: LicenseRecord, claim: LicenseClaim): boolean {
  return (
    record.jurisdictionId === claim.jurisdiction_id &&
    record.licenseNumber === claim.license_number &&
    record.licenseType === claim.license_type &&
    record.effectiveFrom === claim.effective_from &&
    record.effectiveUntil === claim.effective_until &&
    record.reportedStatus === null
  );
}

// Adds a license claim (record omitted) or revises one of the attorney's own
// unreviewed license claims (record names it). The source-observed status is
// never set here.
export async function saveLicenseClaim(
  sources: AttorneyProfessionalSources,
  formData: unknown,
): Promise<ProfessionalActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return UNAVAILABLE;
    }
    const recordField = single(formData, "record");
    const recordId = recordField === "" ? null : recordIdOf(formData);
    if (recordField !== "" && recordId === null) {
      return UNAVAILABLE;
    }
    const writable = await writableOf(sources);
    if (!("context" in writable)) {
      return writable;
    }
    const { context, reads, provisioning } = writable;
    const jurisdictions = await jurisdictionIdsOf(provisioning);
    if (jurisdictions === null) {
      return UNAVAILABLE;
    }
    const claim = licenseClaimOf(formData, jurisdictions);
    if ("status" in claim) {
      return claim;
    }
    const attorneyId = context.profile.id;
    let before: LicenseRecord | null = null;
    let writeId: string | null = null;
    if (recordId !== null) {
      const own = ownedRows(
        await attempt(() => reads.licensesOf(attorneyId)),
        readLicense,
        attorneyId,
      );
      if (own === null) {
        return UNAVAILABLE;
      }
      before = own.find((record) => record.id === recordId) ?? null;
      if (before === null) {
        return DENIED;
      }
      const flags = await evidenceStatusOf(provisioning, "license", [recordId]);
      if (flags === null) {
        return UNAVAILABLE;
      }
      if (flags.size > 0 || before.reportedStatus !== null) {
        return LOCKED;
      }
      const expectedUpdatedAt = before.updatedAt;
      const updated = rowsOf(
        await attempt(() =>
          provisioning.updateLicense(
            attorneyId,
            recordId,
            expectedUpdatedAt,
            claim,
          ),
        ),
      );
      if (updated !== null && updated.length === 0) {
        return NOT_SAVED;
      }
      writeId = recordId;
    } else {
      const inserted = rowsOf(
        await attempt(() => provisioning.insertLicense(attorneyId, claim)),
      );
      // A refused insert (a duplicate number included) changes nothing;
      // the fresh read below decides whether anything was kept.
      const row = inserted?.length === 1 ? readLicense(inserted[0]) : null;
      writeId = row?.id ?? null;
    }
    const fresh = ownedRows(
      await attempt(() => reads.licensesOf(attorneyId)),
      readLicense,
      attorneyId,
    );
    if (fresh === null) {
      return UNCONFIRMED;
    }
    const kept =
      writeId === null
        ? null
        : (fresh.find((record) => record.id === writeId) ?? null);
    if (kept === null || !sameLicense(kept, claim)) {
      return writeId === null && recordId === null ? NOT_SAVED : UNCONFIRMED;
    }
    return await audited(
      provisioning,
      auditEventOf({
        actorUserId: context.userId,
        actorType: "attorney",
        action:
          before === null
            ? AUDIT_ACTIONS.claimRecorded
            : AUDIT_ACTIONS.claimRevised,
        resourceType: "license",
        resourceId: kept.id,
        before: before === null ? null : claimSnapshotOfLicense(before),
        after: claimSnapshotOfLicense(claim),
        jurisdictionId: claim.jurisdiction_id,
        occurredAtMs: sources.clock(),
      }),
    );
  } catch {
    return UNAVAILABLE;
  }
}

function insuranceClaimOf(
  formData: FormData,
  jurisdictions: readonly string[],
): InsuranceClaim | ProfessionalActionState {
  const collected: Collected = { errors: {} };
  const jurisdiction = choice(
    collected,
    formData,
    "jurisdiction_id",
    "Jurisdiction",
    jurisdictions,
  );
  const carrier = required(collected, formData, "carrier_name", "Insurer", 120);
  const reference = optional(
    collected,
    formData,
    "policy_reference",
    "Policy reference",
    80,
  );
  const type = optional(
    collected,
    formData,
    "coverage_type",
    "Coverage type",
    80,
  );
  const perOccurrence = optionalCount(
    collected,
    formData,
    "per_occurrence_limit_minor",
    "Per-claim limit",
    9_000_000_000_000,
  );
  const aggregate = optionalCount(
    collected,
    formData,
    "aggregate_limit_minor",
    "Aggregate limit",
    9_000_000_000_000,
  );
  const currencyRaw = single(formData, "currency_code");
  const currency =
    currencyRaw === ""
      ? null
      : (currencyRaw?.trim().toUpperCase() ?? undefined);
  if (
    currency !== null &&
    (currency === undefined || !/^[A-Z]{3}$/.test(currency))
  ) {
    fail(
      collected,
      "currency_code",
      "Currency must be a three-letter code, such as one used on the policy.",
    );
  }
  if ((perOccurrence !== null || aggregate !== null) && currency === null) {
    fail(
      collected,
      "currency_code",
      "Enter the currency of the stated limits.",
    );
  }
  const from = optionalDate(
    collected,
    formData,
    "coverage_from",
    "Coverage start",
  );
  const until = optionalDate(
    collected,
    formData,
    "coverage_until",
    "Coverage end",
  );
  if (typeof from === "string" && typeof until === "string" && until < from) {
    fail(
      collected,
      "coverage_until",
      "Coverage end cannot be before coverage start.",
    );
  }
  if (
    Object.keys(collected.errors).length > 0 ||
    jurisdiction === null ||
    carrier === null ||
    reference === undefined ||
    type === undefined ||
    perOccurrence === undefined ||
    aggregate === undefined ||
    currency === undefined ||
    from === undefined ||
    until === undefined
  ) {
    return invalid(collected.errors);
  }
  return Object.freeze({
    jurisdiction_id: jurisdiction,
    carrier_name: carrier,
    policy_reference: reference,
    coverage_type: type,
    per_occurrence_limit_minor: perOccurrence,
    aggregate_limit_minor: aggregate,
    currency_code: currency,
    coverage_from: from,
    coverage_until: until,
  });
}

function sameInsurance(
  record: InsuranceRecord,
  claim: InsuranceClaim,
): boolean {
  return (
    record.jurisdictionId === claim.jurisdiction_id &&
    record.carrierName === claim.carrier_name &&
    record.policyReference === claim.policy_reference &&
    record.coverageType === claim.coverage_type &&
    record.perOccurrenceLimitMinor === claim.per_occurrence_limit_minor &&
    record.aggregateLimitMinor === claim.aggregate_limit_minor &&
    record.currencyCode === claim.currency_code &&
    record.coverageFrom === claim.coverage_from &&
    record.coverageUntil === claim.coverage_until
  );
}

// Adds an insurance claim or revises one of the attorney's own unreviewed
// insurance claims.
export async function saveInsuranceClaim(
  sources: AttorneyProfessionalSources,
  formData: unknown,
): Promise<ProfessionalActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return UNAVAILABLE;
    }
    const recordField = single(formData, "record");
    const recordId = recordField === "" ? null : recordIdOf(formData);
    if (recordField !== "" && recordId === null) {
      return UNAVAILABLE;
    }
    const writable = await writableOf(sources);
    if (!("context" in writable)) {
      return writable;
    }
    const { context, reads, provisioning } = writable;
    const jurisdictions = await jurisdictionIdsOf(provisioning);
    if (jurisdictions === null) {
      return UNAVAILABLE;
    }
    const claim = insuranceClaimOf(formData, jurisdictions);
    if ("status" in claim) {
      return claim;
    }
    const attorneyId = context.profile.id;
    let before: InsuranceRecord | null = null;
    let writeId: string | null = null;
    if (recordId !== null) {
      const own = ownedRows(
        await attempt(() => reads.insuranceOf(attorneyId)),
        readInsurance,
        attorneyId,
      );
      if (own === null) {
        return UNAVAILABLE;
      }
      before = own.find((record) => record.id === recordId) ?? null;
      if (before === null) {
        return DENIED;
      }
      const flags = await evidenceStatusOf(provisioning, "insurance", [
        recordId,
      ]);
      if (flags === null) {
        return UNAVAILABLE;
      }
      if (flags.size > 0) {
        return LOCKED;
      }
      const expectedUpdatedAt = before.updatedAt;
      const updated = rowsOf(
        await attempt(() =>
          provisioning.updateInsurance(
            attorneyId,
            recordId,
            expectedUpdatedAt,
            claim,
          ),
        ),
      );
      if (updated !== null && updated.length === 0) {
        return NOT_SAVED;
      }
      writeId = recordId;
    } else {
      const inserted = rowsOf(
        await attempt(() => provisioning.insertInsurance(attorneyId, claim)),
      );
      const row = inserted?.length === 1 ? readInsurance(inserted[0]) : null;
      writeId = row?.id ?? null;
    }
    const fresh = ownedRows(
      await attempt(() => reads.insuranceOf(attorneyId)),
      readInsurance,
      attorneyId,
    );
    if (fresh === null) {
      return UNCONFIRMED;
    }
    const kept =
      writeId === null
        ? null
        : (fresh.find((record) => record.id === writeId) ?? null);
    if (kept === null || !sameInsurance(kept, claim)) {
      return writeId === null && recordId === null ? NOT_SAVED : UNCONFIRMED;
    }
    return await audited(
      provisioning,
      auditEventOf({
        actorUserId: context.userId,
        actorType: "attorney",
        action:
          before === null
            ? AUDIT_ACTIONS.claimRecorded
            : AUDIT_ACTIONS.claimRevised,
        resourceType: "insurance_record",
        resourceId: kept.id,
        before: before === null ? null : claimSnapshotOfInsurance(before),
        after: claimSnapshotOfInsurance(claim),
        jurisdictionId: claim.jurisdiction_id,
        occurredAtMs: sources.clock(),
      }),
    );
  } catch {
    return UNAVAILABLE;
  }
}

// Requests a practice-area authorisation in one jurisdiction. A request is
// never an authorisation and never panel membership.
export async function requestPracticeArea(
  sources: AttorneyProfessionalSources,
  formData: unknown,
): Promise<ProfessionalActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return UNAVAILABLE;
    }
    const writable = await writableOf(sources);
    if (!("context" in writable)) {
      return writable;
    }
    const { context, reads, provisioning } = writable;
    const [jurisdictions, areas] = await Promise.all([
      jurisdictionIdsOf(provisioning),
      activePracticeAreaIdsOf(reads),
    ]);
    if (jurisdictions === null || areas === null) {
      return UNAVAILABLE;
    }
    const collected: Collected = { errors: {} };
    const jurisdiction = choice(
      collected,
      formData,
      "jurisdiction_id",
      "Jurisdiction",
      jurisdictions,
    );
    const area = choice(
      collected,
      formData,
      "practice_area_id",
      "Practice area",
      areas,
    );
    if (jurisdiction === null || area === null) {
      return invalid(collected.errors);
    }
    const attorneyId = context.profile.id;
    const existing = ownedRows(
      await attempt(() => reads.authorisationsOf(attorneyId)),
      readPracticeAuthorisation,
      attorneyId,
    );
    if (existing === null) {
      return UNAVAILABLE;
    }
    if (
      existing.some(
        (entry) =>
          entry.jurisdictionId === jurisdiction &&
          entry.practiceAreaId === area,
      )
    ) {
      return invalid({
        practice_area_id: [
          "This practice area is already requested or decided for that jurisdiction.",
        ],
      });
    }
    const requestedAt = new Date(sources.clock()).toISOString();
    const inserted = rowsOf(
      await attempt(() =>
        provisioning.insertAuthorisationRequest(
          attorneyId,
          jurisdiction,
          area,
          requestedAt,
        ),
      ),
    );
    const row =
      inserted?.length === 1 ? readPracticeAuthorisation(inserted[0]) : null;
    const fresh = ownedRows(
      await attempt(() => reads.authorisationsOf(attorneyId)),
      readPracticeAuthorisation,
      attorneyId,
    );
    if (fresh === null) {
      return UNCONFIRMED;
    }
    const kept =
      row === null
        ? null
        : (fresh.find((entry) => entry.id === row.id) ?? null);
    if (
      kept === null ||
      kept.status !== "requested" ||
      kept.jurisdictionId !== jurisdiction ||
      kept.practiceAreaId !== area
    ) {
      return row === null ? NOT_SAVED : UNCONFIRMED;
    }
    return await audited(
      provisioning,
      auditEventOf({
        actorUserId: context.userId,
        actorType: "attorney",
        action: AUDIT_ACTIONS.practiceAreaRequestChanged,
        resourceType: "practice_area_authorisation",
        resourceId: kept.id,
        after: { status: "requested", practice_area_id: area },
        jurisdictionId: jurisdiction,
        occurredAtMs: sources.clock(),
      }),
    );
  } catch {
    return UNAVAILABLE;
  }
}

export const PRACTICE_AREA_REQUEST_INTENTS = Object.freeze([
  "withdraw",
  "renew",
] as const);

// Withdraws one of the attorney's own pending requests, or renews one the
// attorney withdrew. A staff decision is never changed here.
export async function changePracticeAreaRequest(
  sources: AttorneyProfessionalSources,
  formData: unknown,
): Promise<ProfessionalActionState> {
  try {
    if (!(formData instanceof FormData)) {
      return UNAVAILABLE;
    }
    const intent = single(formData, "intent");
    const recordId = recordIdOf(formData);
    if (!isOneOf(PRACTICE_AREA_REQUEST_INTENTS, intent) || recordId === null) {
      return UNAVAILABLE;
    }
    const writable = await writableOf(sources);
    if (!("context" in writable)) {
      return writable;
    }
    const { context, reads, provisioning } = writable;
    const attorneyId = context.profile.id;
    const own = ownedRows(
      await attempt(() => reads.authorisationsOf(attorneyId)),
      readPracticeAuthorisation,
      attorneyId,
    );
    if (own === null) {
      return UNAVAILABLE;
    }
    const entry: PracticeAuthorisationRecord | null =
      own.find((record) => record.id === recordId) ?? null;
    if (entry === null) {
      return DENIED;
    }
    const expected = intent === "withdraw" ? "requested" : "withdrawn";
    if (entry.status !== expected) {
      return LOCKED;
    }
    const nextStatus = intent === "withdraw" ? "withdrawn" : "requested";
    const next =
      nextStatus === "withdrawn"
        ? ({ status: "withdrawn" } as const)
        : ({
            status: "requested",
            requestedAt: new Date(sources.clock()).toISOString(),
          } as const);
    const count = rowCountOf(
      await attempt(() =>
        provisioning.updateAuthorisationRequest(
          attorneyId,
          recordId,
          expected,
          entry.updatedAt,
          next,
        ),
      ),
    );
    const fresh = ownedRows(
      await attempt(() => reads.authorisationsOf(attorneyId)),
      readPracticeAuthorisation,
      attorneyId,
    );
    const kept = fresh?.find((record) => record.id === recordId) ?? null;
    if (kept === null || kept.status !== nextStatus) {
      return count === 0 ? NOT_SAVED : UNCONFIRMED;
    }
    return await audited(
      provisioning,
      auditEventOf({
        actorUserId: context.userId,
        actorType: "attorney",
        action: AUDIT_ACTIONS.practiceAreaRequestChanged,
        resourceType: "practice_area_authorisation",
        resourceId: recordId,
        before: { status: expected },
        after: { status: nextStatus },
        jurisdictionId: entry.jurisdictionId,
        occurredAtMs: sources.clock(),
      }),
    );
  } catch {
    return UNAVAILABLE;
  }
}

export const SUBMIT_APPLICATION_INTENT = Object.freeze({
  field: "intent",
  value: "submit-application-for-review",
} as const);

// Submits the attorney's own application for review: applicant to
// under_review, and nothing else. It needs at least one license claim, and
// it approves, verifies, or authorises nothing.
export async function submitApplicationForReview(
  sources: AttorneyProfessionalSources,
  formData: unknown,
): Promise<ProfessionalActionState> {
  try {
    if (
      !(formData instanceof FormData) ||
      single(formData, SUBMIT_APPLICATION_INTENT.field) !==
        SUBMIT_APPLICATION_INTENT.value
    ) {
      return UNAVAILABLE;
    }
    const writable = await writableOf(sources);
    if (!("context" in writable)) {
      return writable;
    }
    const { context, reads, provisioning } = writable;
    const licenses = ownedRows(
      await attempt(() => reads.licensesOf(context.profile.id)),
      readLicense,
      context.profile.id,
    );
    if (licenses === null) {
      return UNAVAILABLE;
    }
    if (licenses.length === 0) {
      return invalid({
        submit: ["Add at least one license claim before submitting."],
      });
    }
    const count = rowCountOf(
      await attempt(() =>
        provisioning.submitApplication(context.profile.id, context.userId),
      ),
    );
    const fresh = await attorneyContextOf(sources, reads);
    if (!("profile" in fresh) || fresh.profile.id !== context.profile.id) {
      return UNCONFIRMED;
    }
    if (fresh.profile.state !== "under_review") {
      return count === 0 ? NOT_SAVED : UNCONFIRMED;
    }
    return await audited(
      provisioning,
      auditEventOf({
        actorUserId: context.userId,
        actorType: "attorney",
        action: AUDIT_ACTIONS.applicationSubmitted,
        resourceType: "attorney_profile",
        resourceId: context.profile.id,
        before: { profile_state: "applicant" },
        after: { profile_state: "under_review" },
        occurredAtMs: sources.clock(),
      }),
    );
  } catch {
    return UNAVAILABLE;
  }
}
