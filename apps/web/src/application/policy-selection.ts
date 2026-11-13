// Applicable eligibility policy selection (P3-003).
//
// Pure and deterministic. Given the policy versions and authority references
// a trusted server read returned for one explicit policy type and one
// jurisdiction, and the instant being assessed, it selects the single policy
// version that is approved, active, effective at that instant, mode-neutral,
// and backed by verified authority provenance, and reads its parameters in
// one exact shape. It never supplies a default parameter, never picks a
// "latest" version, never widens to another jurisdiction, and never treats a
// draft, review, scheduled, suspended, retired, expired, conflicting, or
// mode-specific version as applicable: each of those returns a fixed
// undetermined reason instead. No policy value or legal rule is defined here;
// absent an actually approved policy, nothing can be determined.

import {
  epochOf,
  isOneOf,
  isTimestamp,
  isUuid,
  readExact,
} from "./professional-records.ts";

// The policy type this work item consumes and the parameter schema it reads.
// Both are implementation contracts awaiting configuration: no policy type
// row, policy version, or parameter value is created by this work item.
export const ELIGIBILITY_POLICY_TYPE = "attorney_eligibility";
export const ELIGIBILITY_POLICY_SCHEMA = "rosuno.attorney_eligibility.v1";

export const POLICY_VERSION_COLUMNS =
  "id, policy_type_code, jurisdiction_id, regulatory_mode_id, version_label, parameters, status, effective_from, effective_until, approved_at, approved_by_user_id";
export const AUTHORITY_REFERENCE_COLUMNS =
  "id, policy_version_id, verification_status, verified_by_user_id";

const POLICY_STATUSES = Object.freeze([
  "draft",
  "internal_review",
  "counsel_review",
  "approved",
  "scheduled",
  "active",
  "suspended",
  "retired",
] as const);

export type EligibilityPolicy = {
  readonly versionId: string;
  readonly versionLabel: string;
  readonly jurisdictionId: string;
  readonly license: {
    readonly qualifyingReportedStatuses: readonly string[];
    readonly evidenceMaxAgeDays: number;
  };
  readonly insurance: {
    readonly required: boolean;
    readonly evidenceMaxAgeDays: number | null;
    readonly minimumPerOccurrenceMinor: number | null;
    readonly minimumAggregateMinor: number | null;
    readonly currencyCode: string | null;
  };
  readonly discipline: {
    readonly disqualifyingStatuses: readonly string[];
    readonly clearedStatuses: readonly string[];
  };
  readonly practiceArea: {
    readonly authorisationRequired: boolean;
  };
};

export type PolicyUndeterminedReason =
  | "policy_records_unreadable"
  | "no_applicable_policy"
  | "conflicting_policies"
  | "regulatory_mode_undetermined"
  | "authority_unverified"
  | "policy_parameters_unreadable";

export type PolicySelection =
  | { readonly status: "selected"; readonly policy: EligibilityPolicy }
  | {
      readonly status: "undetermined";
      readonly reason: PolicyUndeterminedReason;
    };

type PolicyVersionRow = {
  readonly id: string;
  readonly typeCode: string;
  readonly jurisdictionId: string | null;
  readonly regulatoryModeId: string | null;
  readonly versionLabel: string;
  readonly parameters: unknown;
  readonly status: (typeof POLICY_STATUSES)[number];
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly approvedAt: string | null;
  readonly approvedBy: string | null;
};

function undetermined(reason: PolicyUndeterminedReason): PolicySelection {
  return Object.freeze({ status: "undetermined", reason });
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function readVersion(row: unknown): PolicyVersionRow | null {
  const f = readExact(row, POLICY_VERSION_COLUMNS.split(", "));
  if (f === null) {
    return null;
  }
  const id = f.get("id");
  const typeCode = f.get("policy_type_code");
  const jurisdictionId = f.get("jurisdiction_id");
  const modeId = f.get("regulatory_mode_id");
  const label = f.get("version_label");
  const status = f.get("status");
  const effectiveFrom = f.get("effective_from");
  const effectiveUntil = f.get("effective_until");
  const approvedAt = f.get("approved_at");
  const approvedBy = f.get("approved_by_user_id");
  if (
    !isUuid(id) ||
    typeof typeCode !== "string" ||
    !(jurisdictionId === null || isUuid(jurisdictionId)) ||
    !(modeId === null || isUuid(modeId)) ||
    typeof label !== "string" ||
    !isOneOf(POLICY_STATUSES, status) ||
    !nullableTimestamp(effectiveFrom) ||
    !nullableTimestamp(effectiveUntil) ||
    !nullableTimestamp(approvedAt) ||
    !(approvedBy === null || isUuid(approvedBy))
  ) {
    return null;
  }
  return {
    id,
    typeCode,
    jurisdictionId,
    regulatoryModeId: modeId,
    versionLabel: label,
    parameters: f.get("parameters"),
    status,
    effectiveFrom,
    effectiveUntil,
    approvedAt,
    approvedBy,
  };
}

type AuthorityRow = {
  readonly policyVersionId: string;
  readonly verified: boolean;
};

function readAuthority(row: unknown): AuthorityRow | null {
  const f = readExact(row, AUTHORITY_REFERENCE_COLUMNS.split(", "));
  if (f === null) {
    return null;
  }
  const versionId = f.get("policy_version_id");
  const status = f.get("verification_status");
  const verifiedBy = f.get("verified_by_user_id");
  if (
    !isUuid(f.get("id")) ||
    !isUuid(versionId) ||
    typeof status !== "string" ||
    !(verifiedBy === null || isUuid(verifiedBy))
  ) {
    return null;
  }
  return {
    policyVersionId: versionId,
    verified: status === "verified" && verifiedBy !== null,
  };
}

// In force at the instant: active, approved by a recorded actor, and inside
// its effective period. Anything else is not applicable at that instant.
function inForce(version: PolicyVersionRow, asOfMs: number): boolean {
  if (
    version.status !== "active" ||
    version.approvedAt === null ||
    version.approvedBy === null ||
    version.effectiveFrom === null
  ) {
    return false;
  }
  if (epochOf(version.effectiveFrom) > asOfMs) {
    return false;
  }
  return (
    version.effectiveUntil === null || epochOf(version.effectiveUntil) > asOfMs
  );
}

function isStatusList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.trim() !== "") &&
    new Set(value).size === value.length
  );
}

function isDays(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isMinor(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

// The parameters in exactly the declared schema, or null. Every key is
// required; null is accepted only where the schema says so, and only as an
// explicit value.
function readParameters(
  parameters: unknown,
): Omit<
  EligibilityPolicy,
  "versionId" | "versionLabel" | "jurisdictionId"
> | null {
  const top = readExact(parameters, [
    "schema",
    "license",
    "insurance",
    "discipline",
    "practice_area",
  ]);
  if (top === null || top.get("schema") !== ELIGIBILITY_POLICY_SCHEMA) {
    return null;
  }
  const license = readExact(top.get("license"), [
    "qualifying_reported_statuses",
    "evidence_max_age_days",
  ]);
  const insurance = readExact(top.get("insurance"), [
    "required",
    "evidence_max_age_days",
    "minimum_per_occurrence_minor",
    "minimum_aggregate_minor",
    "currency_code",
  ]);
  const discipline = readExact(top.get("discipline"), [
    "disqualifying_statuses",
    "cleared_statuses",
  ]);
  const practice = readExact(top.get("practice_area"), [
    "authorisation_required",
  ]);
  if (
    license === null ||
    insurance === null ||
    discipline === null ||
    practice === null
  ) {
    return null;
  }
  const qualifying = license.get("qualifying_reported_statuses");
  const licenseAge = license.get("evidence_max_age_days");
  const required = insurance.get("required");
  const insuranceAge = insurance.get("evidence_max_age_days");
  const perOccurrence = insurance.get("minimum_per_occurrence_minor");
  const aggregate = insurance.get("minimum_aggregate_minor");
  const currency = insurance.get("currency_code");
  const disqualifying = discipline.get("disqualifying_statuses");
  const cleared = discipline.get("cleared_statuses");
  const authorisation = practice.get("authorisation_required");
  if (
    !isStatusList(qualifying) ||
    qualifying.length === 0 ||
    !isDays(licenseAge) ||
    typeof required !== "boolean" ||
    !(insuranceAge === null || isDays(insuranceAge)) ||
    !(perOccurrence === null || isMinor(perOccurrence)) ||
    !(aggregate === null || isMinor(aggregate)) ||
    !(
      currency === null ||
      (typeof currency === "string" && /^[A-Z]{3}$/.test(currency))
    ) ||
    !isStatusList(disqualifying) ||
    !isStatusList(cleared) ||
    disqualifying.some((status) => cleared.includes(status)) ||
    typeof authorisation !== "boolean"
  ) {
    return null;
  }
  // A monetary minimum is meaningless without its currency.
  if ((perOccurrence !== null || aggregate !== null) && currency === null) {
    return null;
  }
  return {
    license: Object.freeze({
      qualifyingReportedStatuses: Object.freeze([...qualifying]),
      evidenceMaxAgeDays: licenseAge,
    }),
    insurance: Object.freeze({
      required,
      evidenceMaxAgeDays: insuranceAge,
      minimumPerOccurrenceMinor: perOccurrence,
      minimumAggregateMinor: aggregate,
      currencyCode: currency,
    }),
    discipline: Object.freeze({
      disqualifyingStatuses: Object.freeze([...disqualifying]),
      clearedStatuses: Object.freeze([...cleared]),
    }),
    practiceArea: Object.freeze({ authorisationRequired: authorisation }),
  };
}

// Selects the one applicable eligibility policy for exactly this
// jurisdiction at exactly this instant, or a fixed undetermined reason.
// versions and authorities are null when the trusted read failed.
export function selectEligibilityPolicy(
  jurisdictionId: string,
  asOfMs: number,
  versions: readonly unknown[] | null,
  authorities: readonly unknown[] | null,
): PolicySelection {
  if (versions === null || authorities === null || !Number.isFinite(asOfMs)) {
    return undetermined("policy_records_unreadable");
  }
  const read: PolicyVersionRow[] = [];
  for (const row of versions) {
    const version = readVersion(row);
    // Only rows of exactly this type and jurisdiction may be handed in.
    if (
      version === null ||
      version.typeCode !== ELIGIBILITY_POLICY_TYPE ||
      version.jurisdictionId !== jurisdictionId
    ) {
      return undetermined("policy_records_unreadable");
    }
    read.push(version);
  }
  const references: AuthorityRow[] = [];
  for (const row of authorities) {
    const reference = readAuthority(row);
    if (reference === null) {
      return undetermined("policy_records_unreadable");
    }
    references.push(reference);
  }
  const applicable = read.filter((version) => inForce(version, asOfMs));
  if (applicable.some((version) => version.regulatoryModeId !== null)) {
    // Jurisdiction regulatory-mode selection is counsel-gated: a
    // mode-specific version is never applied by this work item.
    return undetermined("regulatory_mode_undetermined");
  }
  if (applicable.length === 0) {
    return undetermined("no_applicable_policy");
  }
  if (applicable.length > 1) {
    return undetermined("conflicting_policies");
  }
  const version = applicable[0];
  if (
    !references.some(
      (reference) =>
        reference.policyVersionId === version.id && reference.verified,
    )
  ) {
    return undetermined("authority_unverified");
  }
  const parameters = readParameters(version.parameters);
  if (parameters === null) {
    return undetermined("policy_parameters_unreadable");
  }
  return Object.freeze({
    status: "selected",
    policy: Object.freeze({
      versionId: version.id,
      versionLabel: version.versionLabel,
      jurisdictionId,
      ...parameters,
    }),
  });
}
