// Professional record contracts (P3-003).
//
// The one place that names the existing M4 physical columns this work item
// reads and writes, the existing lifecycle vocabularies, and strict readers
// that turn a database row into a frozen record. Every reader takes a row
// only in its exact selected shape: a missing, extra, accessor, or malformed
// field makes the whole row unreadable, and callers fail closed on that. No
// default, fallback, or inferred value is ever supplied for a missing one.
// Nothing here reads a request, a provider, or the database; it only checks
// values that trusted server reads hand in.

// The existing Attorney Profile lifecycle (P1 M4 migration). Nothing here
// adds a stage.
export const PROFILE_STATES = Object.freeze([
  "applicant",
  "under_review",
  "approved",
  "suspended",
  "removed",
] as const);
export type ProfileState = (typeof PROFILE_STATES)[number];

// The existing Rosuno User account states (P1 platform migration).
export const ACCOUNT_STATES = Object.freeze([
  "pending_verification",
  "active",
  "suspended",
  "closed",
] as const);
export type AccountState = (typeof ACCOUNT_STATES)[number];

// The existing Staff Profile states (P1 authorization correction).
export const STAFF_STATES = Object.freeze([
  "invited",
  "active",
  "deactivated",
  "removed",
] as const);
export type StaffState = (typeof STAFF_STATES)[number];

// The working vocabulary this work item writes to the free-text
// practice_area_authorisations.status column: an attorney request, the
// attorney's withdrawal of a pending request, and the two staff decisions.
// It is an application contract recorded for owner confirmation against the
// locked Domain Model, not a new database constraint.
export const PRACTICE_AUTHORISATION_STATUSES = Object.freeze([
  "requested",
  "withdrawn",
  "authorised",
  "refused",
] as const);
export type PracticeAuthorisationStatus =
  (typeof PRACTICE_AUTHORISATION_STATUSES)[number];

// Exact select lists. Readers below accept exactly these keys.
export const PROFILE_COLUMNS =
  "id, user_id, display_name, headline, bio, years_experience, profile_state, created_at, updated_at";
export const LICENSE_COLUMNS =
  "id, attorney_id, jurisdiction_id, license_number, license_type, effective_from, effective_until, reported_status, created_at, updated_at";
export const INSURANCE_COLUMNS =
  "id, attorney_id, jurisdiction_id, carrier_name, policy_reference, coverage_type, per_occurrence_limit_minor, aggregate_limit_minor, currency_code, coverage_from, coverage_until, created_at, updated_at";
export const DISCIPLINE_COLUMNS =
  "id, attorney_id, jurisdiction_id, external_reference, finding_type, opened_at, resolved_at, status, created_at, updated_at";
export const PRACTICE_AUTHORISATION_COLUMNS =
  "id, attorney_id, jurisdiction_id, practice_area_id, status, requested_at, decided_at, effective_from, effective_until, criteria_policy_version_id, created_at, updated_at";
export const EVIDENCE_COLUMNS =
  "id, jurisdiction_id, source_type, source_uri, source_reference, retrieved_at, retrieved_by_user_id, evidence_summary, evidence_digest, verification_method, discrepancy_flag, retention_class, created_at";
export const EVIDENCE_SUBJECT_COLUMNS =
  "id, verification_evidence_id, license_id, insurance_record_id, discipline_record_id, practice_area_authorisation_id, created_at";
export const EVALUATION_COLUMNS =
  "id, attorney_id, jurisdiction_id, context_type, context_id, evaluated_at, policy_references, result, factor_results, evidence_references, as_of, created_at";
export const JURISDICTION_COLUMNS = "id, code, name, lifecycle_state";
export const PRACTICE_AREA_COLUMNS = "id, code, name, active";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// A timestamp with an explicit offset, as PostgREST reports timestamptz.
const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isOneOf<T extends string>(
  list: readonly T[],
  value: unknown,
): value is T {
  return list.some((entry) => entry === value);
}

// A real calendar date in YYYY-MM-DD form; 2026-02-30 is not one.
export function isDate(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = DATE.exec(value);
  if (match === null) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    TIMESTAMP.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

// Milliseconds since the epoch of a checked timestamp.
export function epochOf(timestamp: string): number {
  return Date.parse(timestamp);
}

// The UTC calendar date of an instant, for comparison with date columns.
export function utcDateOf(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

// The own data fields of a plain record holding exactly these keys, each read
// once, or null for anything else: a missing or extra key, an accessor, a
// symbol key, an array, or a value that throws when inspected.
export function readExact(
  value: unknown,
  keys: readonly string[],
): ReadonlyMap<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length) {
      return null;
    }
    const fields = new Map<string, unknown>();
    for (const key of own) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== "string" ||
        !keys.includes(key) ||
        descriptor === undefined ||
        !("value" in descriptor)
      ) {
        return null;
      }
      fields.set(key, descriptor.value);
    }
    return fields;
  } catch {
    return null;
  }
}

function columnsOf(list: string): readonly string[] {
  return list.split(", ");
}

// Field checks used by the readers. Each answers whether a value is usable.
const nullable =
  (check: (value: unknown) => boolean) =>
  (value: unknown): boolean =>
    value === null || check(value);

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCurrency(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

const ANY = (): boolean => true;

type Checks = Readonly<Record<string, (value: unknown) => boolean>>;

// Reads a row against its exact columns and per-column checks, or null.
function readRow<T>(
  row: unknown,
  columns: string,
  checks: Checks,
  build: (fields: ReadonlyMap<string, unknown>) => T,
): T | null {
  const keys = columnsOf(columns);
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
  return Object.freeze(build(fields));
}

// Reads every row or none: one unreadable row makes the whole list unreadable.
export function readRows<T>(
  rows: readonly unknown[],
  reader: (row: unknown) => T | null,
): readonly T[] | null {
  const read: T[] = [];
  for (const row of rows) {
    const record = reader(row);
    if (record === null) {
      return null;
    }
    read.push(record);
  }
  return Object.freeze(read);
}

export type ProfileRecord = {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string | null;
  readonly headline: string | null;
  readonly bio: string | null;
  readonly yearsExperience: number | null;
  readonly state: ProfileState;
  readonly updatedAt: string;
};

export function readProfile(row: unknown): ProfileRecord | null {
  return readRow(
    row,
    PROFILE_COLUMNS,
    {
      id: isUuid,
      user_id: isUuid,
      display_name: nullable((value) => typeof value === "string"),
      headline: nullable((value) => typeof value === "string"),
      bio: nullable((value) => typeof value === "string"),
      years_experience: nullable(isCount),
      profile_state: (value) => isOneOf(PROFILE_STATES, value),
      created_at: isTimestamp,
      updated_at: isTimestamp,
    },
    (f) => ({
      id: f.get("id") as string,
      userId: f.get("user_id") as string,
      displayName: f.get("display_name") as string | null,
      headline: f.get("headline") as string | null,
      bio: f.get("bio") as string | null,
      yearsExperience: f.get("years_experience") as number | null,
      state: f.get("profile_state") as ProfileState,
      updatedAt: f.get("updated_at") as string,
    }),
  );
}

export type LicenseRecord = {
  readonly id: string;
  readonly attorneyId: string;
  readonly jurisdictionId: string;
  readonly licenseNumber: string;
  readonly licenseType: string | null;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  // Source-observed status recorded by review staff, never the attorney.
  readonly reportedStatus: string | null;
  readonly updatedAt: string;
};

export function readLicense(row: unknown): LicenseRecord | null {
  return readRow(
    row,
    LICENSE_COLUMNS,
    {
      id: isUuid,
      attorney_id: isUuid,
      jurisdiction_id: isUuid,
      license_number: isText,
      license_type: nullable((value) => typeof value === "string"),
      effective_from: nullable(isDate),
      effective_until: nullable(isDate),
      reported_status: nullable(isText),
      created_at: isTimestamp,
      updated_at: isTimestamp,
    },
    (f) => ({
      id: f.get("id") as string,
      attorneyId: f.get("attorney_id") as string,
      jurisdictionId: f.get("jurisdiction_id") as string,
      licenseNumber: f.get("license_number") as string,
      licenseType: f.get("license_type") as string | null,
      effectiveFrom: f.get("effective_from") as string | null,
      effectiveUntil: f.get("effective_until") as string | null,
      reportedStatus: f.get("reported_status") as string | null,
      updatedAt: f.get("updated_at") as string,
    }),
  );
}

export type InsuranceRecord = {
  readonly id: string;
  readonly attorneyId: string;
  readonly jurisdictionId: string | null;
  readonly carrierName: string | null;
  readonly policyReference: string | null;
  readonly coverageType: string | null;
  readonly perOccurrenceLimitMinor: number | null;
  readonly aggregateLimitMinor: number | null;
  readonly currencyCode: string | null;
  readonly coverageFrom: string | null;
  readonly coverageUntil: string | null;
  readonly updatedAt: string;
};

export function readInsurance(row: unknown): InsuranceRecord | null {
  return readRow(
    row,
    INSURANCE_COLUMNS,
    {
      id: isUuid,
      attorney_id: isUuid,
      jurisdiction_id: nullable(isUuid),
      carrier_name: nullable((value) => typeof value === "string"),
      policy_reference: nullable((value) => typeof value === "string"),
      coverage_type: nullable((value) => typeof value === "string"),
      per_occurrence_limit_minor: nullable(isCount),
      aggregate_limit_minor: nullable(isCount),
      currency_code: nullable(isCurrency),
      coverage_from: nullable(isDate),
      coverage_until: nullable(isDate),
      created_at: isTimestamp,
      updated_at: isTimestamp,
    },
    (f) => ({
      id: f.get("id") as string,
      attorneyId: f.get("attorney_id") as string,
      jurisdictionId: f.get("jurisdiction_id") as string | null,
      carrierName: f.get("carrier_name") as string | null,
      policyReference: f.get("policy_reference") as string | null,
      coverageType: f.get("coverage_type") as string | null,
      perOccurrenceLimitMinor: f.get("per_occurrence_limit_minor") as
        number | null,
      aggregateLimitMinor: f.get("aggregate_limit_minor") as number | null,
      currencyCode: f.get("currency_code") as string | null,
      coverageFrom: f.get("coverage_from") as string | null,
      coverageUntil: f.get("coverage_until") as string | null,
      updatedAt: f.get("updated_at") as string,
    }),
  );
}

export type DisciplineRecord = {
  readonly id: string;
  readonly attorneyId: string;
  readonly jurisdictionId: string;
  readonly externalReference: string | null;
  readonly findingType: string | null;
  readonly openedAt: string | null;
  readonly resolvedAt: string | null;
  readonly status: string | null;
  readonly updatedAt: string;
};

export function readDiscipline(row: unknown): DisciplineRecord | null {
  return readRow(
    row,
    DISCIPLINE_COLUMNS,
    {
      id: isUuid,
      attorney_id: isUuid,
      jurisdiction_id: isUuid,
      external_reference: nullable((value) => typeof value === "string"),
      finding_type: nullable((value) => typeof value === "string"),
      opened_at: nullable(isDate),
      resolved_at: nullable(isDate),
      status: nullable((value) => typeof value === "string"),
      created_at: isTimestamp,
      updated_at: isTimestamp,
    },
    (f) => ({
      id: f.get("id") as string,
      attorneyId: f.get("attorney_id") as string,
      jurisdictionId: f.get("jurisdiction_id") as string,
      externalReference: f.get("external_reference") as string | null,
      findingType: f.get("finding_type") as string | null,
      openedAt: f.get("opened_at") as string | null,
      resolvedAt: f.get("resolved_at") as string | null,
      status: f.get("status") as string | null,
      updatedAt: f.get("updated_at") as string,
    }),
  );
}

export type PracticeAuthorisationRecord = {
  readonly id: string;
  readonly attorneyId: string;
  readonly jurisdictionId: string;
  readonly practiceAreaId: string;
  // Exactly as stored; a value outside the working vocabulary is kept so
  // that callers can refuse to decide on it.
  readonly status: string;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly criteriaPolicyVersionId: string | null;
  readonly updatedAt: string;
};

export function readPracticeAuthorisation(
  row: unknown,
): PracticeAuthorisationRecord | null {
  return readRow(
    row,
    PRACTICE_AUTHORISATION_COLUMNS,
    {
      id: isUuid,
      attorney_id: isUuid,
      jurisdiction_id: isUuid,
      practice_area_id: isUuid,
      status: isText,
      requested_at: isTimestamp,
      decided_at: nullable(isTimestamp),
      effective_from: nullable(isTimestamp),
      effective_until: nullable(isTimestamp),
      criteria_policy_version_id: nullable(isUuid),
      created_at: isTimestamp,
      updated_at: isTimestamp,
    },
    (f) => ({
      id: f.get("id") as string,
      attorneyId: f.get("attorney_id") as string,
      jurisdictionId: f.get("jurisdiction_id") as string,
      practiceAreaId: f.get("practice_area_id") as string,
      status: f.get("status") as string,
      requestedAt: f.get("requested_at") as string,
      decidedAt: f.get("decided_at") as string | null,
      effectiveFrom: f.get("effective_from") as string | null,
      effectiveUntil: f.get("effective_until") as string | null,
      criteriaPolicyVersionId: f.get("criteria_policy_version_id") as
        string | null,
      updatedAt: f.get("updated_at") as string,
    }),
  );
}

export type EvidenceRecord = {
  readonly id: string;
  readonly jurisdictionId: string | null;
  readonly sourceType: string | null;
  readonly sourceUri: string | null;
  readonly sourceReference: string | null;
  readonly retrievedAt: string;
  readonly retrievedByUserId: string | null;
  readonly summary: string | null;
  readonly digest: string | null;
  readonly method: string | null;
  readonly discrepancy: boolean;
  readonly retentionClass: string | null;
  readonly createdAt: string;
};

export function readEvidence(row: unknown): EvidenceRecord | null {
  const text = nullable((value) => typeof value === "string");
  return readRow(
    row,
    EVIDENCE_COLUMNS,
    {
      id: isUuid,
      jurisdiction_id: nullable(isUuid),
      source_type: text,
      source_uri: text,
      source_reference: text,
      retrieved_at: isTimestamp,
      retrieved_by_user_id: nullable(isUuid),
      evidence_summary: text,
      evidence_digest: text,
      verification_method: text,
      discrepancy_flag: (value) => typeof value === "boolean",
      retention_class: text,
      created_at: isTimestamp,
    },
    (f) => ({
      id: f.get("id") as string,
      jurisdictionId: f.get("jurisdiction_id") as string | null,
      sourceType: f.get("source_type") as string | null,
      sourceUri: f.get("source_uri") as string | null,
      sourceReference: f.get("source_reference") as string | null,
      retrievedAt: f.get("retrieved_at") as string,
      retrievedByUserId: f.get("retrieved_by_user_id") as string | null,
      summary: f.get("evidence_summary") as string | null,
      digest: f.get("evidence_digest") as string | null,
      method: f.get("verification_method") as string | null,
      discrepancy: f.get("discrepancy_flag") as boolean,
      retentionClass: f.get("retention_class") as string | null,
      createdAt: f.get("created_at") as string,
    }),
  );
}

export type SubjectKind =
  "license" | "insurance" | "discipline" | "practice_area_authorisation";

export type EvidenceSubjectRecord = {
  readonly id: string;
  readonly evidenceId: string;
  readonly kind: SubjectKind;
  readonly subjectId: string;
};

const SUBJECT_COLUMNS: Readonly<Record<SubjectKind, string>> = Object.freeze({
  license: "license_id",
  insurance: "insurance_record_id",
  discipline: "discipline_record_id",
  practice_area_authorisation: "practice_area_authorisation_id",
});

// The subject column for one subject kind, as the bridge table names it.
export function subjectColumnOf(kind: SubjectKind): string {
  return SUBJECT_COLUMNS[kind];
}

// A bridge row names exactly one subject, as its check constraint requires;
// any other shape is unreadable.
export function readEvidenceSubject(
  row: unknown,
): EvidenceSubjectRecord | null {
  const fields = readExact(row, columnsOf(EVIDENCE_SUBJECT_COLUMNS));
  if (
    fields === null ||
    !isUuid(fields.get("id")) ||
    !isUuid(fields.get("verification_evidence_id")) ||
    !isTimestamp(fields.get("created_at"))
  ) {
    return null;
  }
  const named = (Object.keys(SUBJECT_COLUMNS) as SubjectKind[]).filter(
    (kind) => fields.get(SUBJECT_COLUMNS[kind]) !== null,
  );
  if (named.length !== 1) {
    return null;
  }
  const kind = named[0];
  const subjectId = fields.get(SUBJECT_COLUMNS[kind]);
  if (!isUuid(subjectId)) {
    return null;
  }
  return Object.freeze({
    id: fields.get("id") as string,
    evidenceId: fields.get("verification_evidence_id") as string,
    kind,
    subjectId,
  });
}

export type EvaluationRecord = {
  readonly id: string;
  readonly attorneyId: string;
  readonly jurisdictionId: string;
  readonly contextType: string;
  readonly contextId: string | null;
  readonly evaluatedAt: string;
  readonly result: string;
  readonly factorResults: unknown;
  readonly policyReferences: unknown;
  readonly evidenceReferences: unknown;
  readonly asOf: string;
};

export function readEvaluation(row: unknown): EvaluationRecord | null {
  return readRow(
    row,
    EVALUATION_COLUMNS,
    {
      id: isUuid,
      attorney_id: isUuid,
      jurisdiction_id: isUuid,
      context_type: isText,
      context_id: nullable(isUuid),
      evaluated_at: isTimestamp,
      policy_references: ANY,
      result: isText,
      factor_results: ANY,
      evidence_references: ANY,
      as_of: isTimestamp,
      created_at: isTimestamp,
    },
    (f) => ({
      id: f.get("id") as string,
      attorneyId: f.get("attorney_id") as string,
      jurisdictionId: f.get("jurisdiction_id") as string,
      contextType: f.get("context_type") as string,
      contextId: f.get("context_id") as string | null,
      evaluatedAt: f.get("evaluated_at") as string,
      result: f.get("result") as string,
      factorResults: f.get("factor_results"),
      policyReferences: f.get("policy_references"),
      evidenceReferences: f.get("evidence_references"),
      asOf: f.get("as_of") as string,
    }),
  );
}

export type JurisdictionRecord = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
};

export function readJurisdiction(row: unknown): JurisdictionRecord | null {
  return readRow(
    row,
    JURISDICTION_COLUMNS,
    {
      id: isUuid,
      code: isText,
      name: isText,
      lifecycle_state: isText,
    },
    (f) => ({
      id: f.get("id") as string,
      code: f.get("code") as string,
      name: f.get("name") as string,
    }),
  );
}

export type PracticeAreaRecord = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly active: boolean;
};

export function readPracticeArea(row: unknown): PracticeAreaRecord | null {
  return readRow(
    row,
    PRACTICE_AREA_COLUMNS,
    {
      id: isUuid,
      code: isText,
      name: isText,
      active: (value) => typeof value === "boolean",
    },
    (f) => ({
      id: f.get("id") as string,
      code: f.get("code") as string,
      name: f.get("name") as string,
      active: f.get("active") as boolean,
    }),
  );
}
