// Current Eligibility assessment (P3-003).
//
// Pure and deterministic: no clock, request, provider, or database. A trusted
// server read hands in the raw facts for exactly one attorney, one
// jurisdiction, and optionally one practice area, plus the instant being
// assessed; this module reads them strictly and composes an explainable
// assessment from separate factors: the User account, the Attorney Profile
// lifecycle, the applicable approved policy, the license, insurance,
// discipline, and practice-area records, and the verification evidence
// linked to each. A factor that cannot be read or decided is undetermined,
// never assumed: the result is "eligible" only when every factor that
// applies passes under an actually selected policy, "not_eligible" when a
// definite fact fails, and "undetermined" otherwise. An approved profile
// never implies eligibility, and nothing here decides bookability,
// marketplace presentation, scheduling, or any later-stage question.

import {
  ELIGIBILITY_POLICY_TYPE,
  selectEligibilityPolicy,
  type EligibilityPolicy,
  type PolicySelection,
} from "./policy-selection.ts";
import {
  epochOf,
  isUuid,
  readDiscipline,
  readEvidence,
  readEvidenceSubject,
  readInsurance,
  readLicense,
  readPracticeAuthorisation,
  readProfile,
  readRows,
  utcDateOf,
  type DisciplineRecord,
  type EvidenceRecord,
  type InsuranceRecord,
  type LicenseRecord,
  type PracticeAuthorisationRecord,
  type SubjectKind,
} from "./professional-records.ts";

export type EligibilityResult = "eligible" | "not_eligible" | "undetermined";

export type FactorName =
  | "account"
  | "profile"
  | "policy"
  | "license"
  | "insurance"
  | "discipline"
  | "practice_area";

export type FactorOutcome =
  "pass" | "fail" | "undetermined" | "not_required" | "not_applicable";

export type RecordOutcome = {
  readonly id: string;
  readonly outcome: "pass" | "fail" | "undetermined";
  readonly reason: string;
};

export type FactorResult = {
  readonly factor: FactorName;
  readonly outcome: FactorOutcome;
  readonly reason: string;
  readonly records: readonly RecordOutcome[];
};

export type PolicyReference = {
  readonly policy_version_id: string;
  readonly version_label: string;
  readonly policy_type_code: string;
};

export type RecordReferences = {
  readonly evidence_ids: readonly string[];
  readonly license_ids: readonly string[];
  readonly insurance_record_ids: readonly string[];
  readonly discipline_record_ids: readonly string[];
  readonly practice_area_authorisation_ids: readonly string[];
};

export type EligibilityAssessment = {
  readonly result: EligibilityResult;
  readonly attorneyId: string;
  readonly jurisdictionId: string;
  readonly practiceAreaId: string | null;
  readonly asOf: string;
  readonly factors: readonly FactorResult[];
  readonly policyReferences: readonly PolicyReference[];
  readonly references: RecordReferences;
};

// Raw facts, exactly as trusted reads returned them; a null list means the
// read failed. Every list must hold only this attorney's records in this
// jurisdiction (insurance and evidence included), or the facts are
// unreadable.
export type EligibilityFacts = {
  readonly attorneyId: string;
  readonly jurisdictionId: string;
  readonly practiceAreaId: string | null;
  readonly accountState: unknown;
  readonly profile: unknown;
  readonly licenses: readonly unknown[] | null;
  readonly insurance: readonly unknown[] | null;
  readonly discipline: readonly unknown[] | null;
  readonly authorisations: readonly unknown[] | null;
  readonly evidence: readonly unknown[] | null;
  readonly subjects: readonly unknown[] | null;
  readonly policyVersions: readonly unknown[] | null;
  readonly authorityReferences: readonly unknown[] | null;
};

// The persisted context types: a jurisdiction-level determination, or one
// for a single practice area in that jurisdiction.
export const EVALUATION_CONTEXTS = Object.freeze({
  jurisdiction: "jurisdiction",
  practiceArea: "practice_area",
} as const);

const DAY_MS = 86_400_000;

const NO_RECORDS: readonly RecordOutcome[] = Object.freeze([]);

function factor(
  name: FactorName,
  outcome: FactorOutcome,
  reason: string,
  records: readonly RecordOutcome[] = NO_RECORDS,
): FactorResult {
  return Object.freeze({
    factor: name,
    outcome,
    reason,
    records: Object.freeze([...records]),
  });
}

function recordOutcome(
  id: string,
  outcome: RecordOutcome["outcome"],
  reason: string,
): RecordOutcome {
  return Object.freeze({ id, outcome, reason });
}

// The combined result of the factors: any definite failure is not eligible;
// otherwise anything undetermined is undetermined; only all-pass is eligible.
function combine(factors: readonly FactorResult[]): EligibilityResult {
  if (factors.some((entry) => entry.outcome === "fail")) {
    return "not_eligible";
  }
  if (factors.some((entry) => entry.outcome === "undetermined")) {
    return "undetermined";
  }
  return "eligible";
}

// A factor from per-record outcomes where one passing record suffices.
function anyPasses(
  name: FactorName,
  records: readonly RecordOutcome[],
  passReason: string,
  noneReason: string,
): FactorResult {
  if (records.length === 0) {
    return factor(name, "fail", noneReason);
  }
  if (records.some((entry) => entry.outcome === "pass")) {
    return factor(name, "pass", passReason, records);
  }
  if (records.some((entry) => entry.outcome === "undetermined")) {
    return factor(name, "undetermined", "no_record_determined", records);
  }
  return factor(name, "fail", "no_record_qualifies", records);
}

type Linked = ReadonlyMap<string, readonly EvidenceRecord[]>;

// The latest evidence first: by retrieval time, then creation time, then id,
// so the order never depends on how the rows were returned.
function latestFirst(evidence: readonly EvidenceRecord[]): EvidenceRecord[] {
  return [...evidence].sort(
    (a, b) =>
      epochOf(b.retrievedAt) - epochOf(a.retrievedAt) ||
      epochOf(b.createdAt) - epochOf(a.createdAt) ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
}

// Whether the latest evidence for a record supports it at the instant: it
// exists, was retrieved no later than the instant and within the allowed
// age, and records no unresolved discrepancy. Returns the reason it does not,
// or null with the relied-upon evidence id.
function evidenceStanding(
  evidence: readonly EvidenceRecord[] | undefined,
  asOfMs: number,
  maxAgeDays: number | null,
): { readonly reason: string | null; readonly evidenceId: string | null } {
  if (evidence === undefined || evidence.length === 0) {
    return { reason: "no_evidence", evidenceId: null };
  }
  const latest = latestFirst(evidence)[0];
  const retrieved = epochOf(latest.retrievedAt);
  if (retrieved > asOfMs) {
    return { reason: "evidence_after_assessment", evidenceId: latest.id };
  }
  if (maxAgeDays !== null && asOfMs - retrieved > maxAgeDays * DAY_MS) {
    return { reason: "evidence_stale", evidenceId: latest.id };
  }
  if (latest.discrepancy) {
    return {
      reason: "evidence_discrepancy_unresolved",
      evidenceId: latest.id,
    };
  }
  return { reason: null, evidenceId: latest.id };
}

function licenseOutcome(
  license: LicenseRecord,
  policy: EligibilityPolicy,
  linked: Linked,
  asOfMs: number,
  relied: Set<string>,
): RecordOutcome {
  const today = utcDateOf(asOfMs);
  if (license.effectiveUntil !== null && license.effectiveUntil < today) {
    return recordOutcome(license.id, "fail", "license_expired");
  }
  if (license.effectiveFrom !== null && license.effectiveFrom > today) {
    return recordOutcome(license.id, "fail", "license_not_yet_effective");
  }
  const standing = evidenceStanding(
    linked.get(license.id),
    asOfMs,
    policy.license.evidenceMaxAgeDays,
  );
  if (standing.evidenceId !== null) {
    relied.add(standing.evidenceId);
  }
  // Without current evidence, no observed status can be relied upon.
  if (
    standing.reason !== null &&
    standing.reason !== "evidence_discrepancy_unresolved"
  ) {
    return recordOutcome(license.id, "undetermined", standing.reason);
  }
  if (license.reportedStatus === null) {
    return recordOutcome(license.id, "undetermined", "no_source_observation");
  }
  // A current source observation of a non-qualifying status is a definite
  // adverse fact, whether or not it was also flagged as a discrepancy.
  if (
    !policy.license.qualifyingReportedStatuses.includes(license.reportedStatus)
  ) {
    return recordOutcome(license.id, "fail", "reported_status_not_qualifying");
  }
  if (standing.reason !== null) {
    return recordOutcome(license.id, "undetermined", standing.reason);
  }
  return recordOutcome(license.id, "pass", "license_verified");
}

function insuranceOutcome(
  record: InsuranceRecord,
  policy: EligibilityPolicy,
  linked: Linked,
  asOfMs: number,
  relied: Set<string>,
): RecordOutcome {
  const today = utcDateOf(asOfMs);
  const rules = policy.insurance;
  if (record.coverageFrom === null || record.coverageUntil === null) {
    return recordOutcome(record.id, "undetermined", "coverage_period_missing");
  }
  if (record.coverageFrom > today || record.coverageUntil < today) {
    return recordOutcome(record.id, "fail", "coverage_not_current");
  }
  if (
    (rules.minimumPerOccurrenceMinor !== null ||
      rules.minimumAggregateMinor !== null) &&
    record.currencyCode !== rules.currencyCode
  ) {
    return recordOutcome(record.id, "undetermined", "currency_mismatch");
  }
  for (const [minimum, limit] of [
    [rules.minimumPerOccurrenceMinor, record.perOccurrenceLimitMinor],
    [rules.minimumAggregateMinor, record.aggregateLimitMinor],
  ] as const) {
    if (minimum === null) {
      continue;
    }
    if (limit === null) {
      return recordOutcome(record.id, "undetermined", "limit_missing");
    }
    if (limit < minimum) {
      return recordOutcome(record.id, "fail", "limit_below_minimum");
    }
  }
  const standing = evidenceStanding(
    linked.get(record.id),
    asOfMs,
    rules.evidenceMaxAgeDays,
  );
  if (standing.evidenceId !== null) {
    relied.add(standing.evidenceId);
  }
  if (standing.reason !== null) {
    return recordOutcome(record.id, "undetermined", standing.reason);
  }
  return recordOutcome(record.id, "pass", "insurance_verified");
}

function disciplineFactor(
  records: readonly DisciplineRecord[],
  policy: EligibilityPolicy,
  linked: Linked,
  relied: Set<string>,
): FactorResult {
  const outcomes = records.map((record) => {
    for (const evidence of linked.get(record.id) ?? []) {
      relied.add(evidence.id);
    }
    if (
      record.status !== null &&
      policy.discipline.disqualifyingStatuses.includes(record.status)
    ) {
      return recordOutcome(record.id, "fail", "disqualifying_record");
    }
    if (
      record.status !== null &&
      policy.discipline.clearedStatuses.includes(record.status)
    ) {
      return recordOutcome(record.id, "pass", "record_cleared");
    }
    return recordOutcome(record.id, "undetermined", "status_not_classified");
  });
  if (outcomes.some((entry) => entry.outcome === "fail")) {
    return factor("discipline", "fail", "disqualifying_record", outcomes);
  }
  if (outcomes.some((entry) => entry.outcome === "undetermined")) {
    return factor(
      "discipline",
      "undetermined",
      "status_not_classified",
      outcomes,
    );
  }
  // An honest statement of what is on file, never a clean-record finding.
  return factor(
    "discipline",
    "pass",
    "no_disqualifying_record_on_file",
    outcomes,
  );
}

function practiceAreaFactor(
  authorisations: readonly PracticeAuthorisationRecord[],
  practiceAreaId: string | null,
  policy: EligibilityPolicy,
  asOfMs: number,
): FactorResult {
  if (practiceAreaId === null) {
    return factor("practice_area", "not_applicable", "jurisdiction_context");
  }
  if (!policy.practiceArea.authorisationRequired) {
    return factor(
      "practice_area",
      "not_required",
      "authorisation_not_required",
    );
  }
  const matching = authorisations.filter(
    (entry) => entry.practiceAreaId === practiceAreaId,
  );
  if (matching.length === 0) {
    return factor("practice_area", "fail", "no_authorisation");
  }
  const entry = matching[0];
  const outcome = ((): RecordOutcome => {
    switch (entry.status) {
      case "authorised": {
        if (
          entry.effectiveFrom === null ||
          epochOf(entry.effectiveFrom) > asOfMs ||
          (entry.effectiveUntil !== null &&
            epochOf(entry.effectiveUntil) <= asOfMs)
        ) {
          return recordOutcome(entry.id, "fail", "authorisation_not_current");
        }
        return recordOutcome(entry.id, "pass", "authorisation_current");
      }
      case "requested":
        return recordOutcome(entry.id, "undetermined", "authorisation_pending");
      case "refused":
        return recordOutcome(entry.id, "fail", "authorisation_refused");
      case "withdrawn":
        return recordOutcome(entry.id, "fail", "authorisation_withdrawn");
      default:
        return recordOutcome(entry.id, "undetermined", "status_not_classified");
    }
  })();
  const outcomeOf: Record<RecordOutcome["outcome"], FactorOutcome> = {
    pass: "pass",
    fail: "fail",
    undetermined: "undetermined",
  };
  return factor("practice_area", outcomeOf[outcome.outcome], outcome.reason, [
    outcome,
  ]);
}

function accountFactor(state: unknown): FactorResult {
  if (state === "active") {
    return factor("account", "pass", "account_active");
  }
  if (
    state === "pending_verification" ||
    state === "suspended" ||
    state === "closed"
  ) {
    return factor("account", "fail", "account_not_active");
  }
  return factor("account", "undetermined", "account_state_unreadable");
}

function profileFactor(
  profile: ReturnType<typeof readProfile>,
  attorneyId: string,
): FactorResult {
  if (profile === null || profile.id !== attorneyId) {
    return factor("profile", "undetermined", "profile_unreadable");
  }
  switch (profile.state) {
    case "approved":
      return factor("profile", "pass", "profile_approved");
    case "suspended":
    case "removed":
      return factor("profile", "fail", "profile_suspended_or_removed");
    default:
      return factor("profile", "fail", "profile_not_approved");
  }
}

function policyDependent(name: FactorName): FactorResult {
  return factor(name, "undetermined", "policy_undetermined");
}

type ReadFacts = {
  readonly licenses: readonly LicenseRecord[];
  readonly insurance: readonly InsuranceRecord[];
  readonly discipline: readonly DisciplineRecord[];
  readonly authorisations: readonly PracticeAuthorisationRecord[];
  readonly linked: Linked;
};

// Reads the record lists strictly and links evidence to its subjects, or
// null when anything is unreadable, foreign to this attorney or
// jurisdiction, or dangling.
function readFacts(facts: EligibilityFacts): ReadFacts | null {
  if (
    facts.licenses === null ||
    facts.insurance === null ||
    facts.discipline === null ||
    facts.authorisations === null ||
    facts.evidence === null ||
    facts.subjects === null
  ) {
    return null;
  }
  const licenses = readRows(facts.licenses, readLicense);
  const insurance = readRows(facts.insurance, readInsurance);
  const discipline = readRows(facts.discipline, readDiscipline);
  const authorisations = readRows(
    facts.authorisations,
    readPracticeAuthorisation,
  );
  const evidence = readRows(facts.evidence, readEvidence);
  const subjects = readRows(facts.subjects, readEvidenceSubject);
  if (
    licenses === null ||
    insurance === null ||
    discipline === null ||
    authorisations === null ||
    evidence === null ||
    subjects === null
  ) {
    return null;
  }
  const owned = [...licenses, ...insurance, ...discipline, ...authorisations];
  if (
    owned.some(
      (record) =>
        record.attorneyId !== facts.attorneyId ||
        record.jurisdictionId !== facts.jurisdictionId,
    )
  ) {
    return null;
  }
  const kinds = new Map<string, SubjectKind>([
    ...licenses.map((r) => [r.id, "license"] as const),
    ...insurance.map((r) => [r.id, "insurance"] as const),
    ...discipline.map((r) => [r.id, "discipline"] as const),
    ...authorisations.map(
      (r) => [r.id, "practice_area_authorisation"] as const,
    ),
  ]);
  const byId = new Map(evidence.map((entry) => [entry.id, entry]));
  const linked = new Map<string, EvidenceRecord[]>();
  for (const subject of subjects) {
    const entry = byId.get(subject.evidenceId);
    if (kinds.get(subject.subjectId) !== subject.kind || entry === undefined) {
      return null;
    }
    // Evidence recorded for another jurisdiction never supports a record here.
    if (entry.jurisdictionId !== facts.jurisdictionId) {
      continue;
    }
    linked.set(subject.subjectId, [
      ...(linked.get(subject.subjectId) ?? []),
      entry,
    ]);
  }
  return { licenses, insurance, discipline, authorisations, linked };
}

function referencesOf(
  read: ReadFacts | null,
  relied: ReadonlySet<string>,
): RecordReferences {
  const ids = (records: readonly { readonly id: string }[] | undefined) =>
    Object.freeze((records ?? []).map((record) => record.id).sort());
  return Object.freeze({
    evidence_ids: Object.freeze([...relied].sort()),
    license_ids: ids(read?.licenses),
    insurance_record_ids: ids(read?.insurance),
    discipline_record_ids: ids(read?.discipline),
    practice_area_authorisation_ids: ids(read?.authorisations),
  });
}

function policyReferencesOf(
  selection: PolicySelection,
): readonly PolicyReference[] {
  if (selection.status !== "selected") {
    return Object.freeze([]);
  }
  return Object.freeze([
    Object.freeze({
      policy_version_id: selection.policy.versionId,
      version_label: selection.policy.versionLabel,
      policy_type_code: ELIGIBILITY_POLICY_TYPE,
    }),
  ]);
}

// Assesses current Eligibility at exactly asOfMs. It never throws.
export function assessEligibility(
  facts: EligibilityFacts,
  asOfMs: number,
): EligibilityAssessment {
  const base = {
    attorneyId: facts.attorneyId,
    jurisdictionId: facts.jurisdictionId,
    practiceAreaId: facts.practiceAreaId,
    asOf: Number.isFinite(asOfMs) ? new Date(asOfMs).toISOString() : "",
  };
  const unreadable = (): EligibilityAssessment =>
    Object.freeze({
      ...base,
      result: "undetermined",
      factors: Object.freeze([
        factor("account", "undetermined", "facts_unreadable"),
      ]),
      policyReferences: Object.freeze([]),
      references: referencesOf(null, new Set()),
    });
  try {
    if (
      !isUuid(facts.attorneyId) ||
      !isUuid(facts.jurisdictionId) ||
      !(facts.practiceAreaId === null || isUuid(facts.practiceAreaId)) ||
      !Number.isFinite(asOfMs)
    ) {
      return unreadable();
    }
    const read = readFacts(facts);
    if (read === null) {
      return unreadable();
    }
    const selection = selectEligibilityPolicy(
      facts.jurisdictionId,
      asOfMs,
      facts.policyVersions,
      facts.authorityReferences,
    );
    const relied = new Set<string>();
    const factors: FactorResult[] = [
      accountFactor(facts.accountState),
      profileFactor(readProfile(facts.profile), facts.attorneyId),
    ];
    if (selection.status !== "selected") {
      factors.push(
        factor("policy", "undetermined", selection.reason),
        policyDependent("license"),
        policyDependent("insurance"),
        policyDependent("discipline"),
        facts.practiceAreaId === null
          ? factor("practice_area", "not_applicable", "jurisdiction_context")
          : policyDependent("practice_area"),
      );
    } else {
      const policy = selection.policy;
      factors.push(factor("policy", "pass", "policy_selected"));
      factors.push(
        anyPasses(
          "license",
          read.licenses.map((license) =>
            licenseOutcome(license, policy, read.linked, asOfMs, relied),
          ),
          "license_verified",
          "no_license_in_jurisdiction",
        ),
      );
      factors.push(
        policy.insurance.required
          ? anyPasses(
              "insurance",
              read.insurance.map((record) =>
                insuranceOutcome(record, policy, read.linked, asOfMs, relied),
              ),
              "insurance_verified",
              "no_insurance_in_jurisdiction",
            )
          : factor("insurance", "not_required", "insurance_not_required"),
      );
      factors.push(
        disciplineFactor(read.discipline, policy, read.linked, relied),
      );
      factors.push(
        practiceAreaFactor(
          read.authorisations,
          facts.practiceAreaId,
          policy,
          asOfMs,
        ),
      );
    }
    return Object.freeze({
      ...base,
      result: combine(factors),
      factors: Object.freeze(factors),
      policyReferences: policyReferencesOf(selection),
      references: referencesOf(read, relied),
    });
  } catch {
    return unreadable();
  }
}

// The immutable eligibility_evaluations row for one consequential
// determination, or null when the assessment cannot be persisted honestly.
export function evaluationRowOf(
  assessment: EligibilityAssessment,
  evaluatedAtMs: number,
): Readonly<Record<string, unknown>> | null {
  if (
    !isUuid(assessment.attorneyId) ||
    !isUuid(assessment.jurisdictionId) ||
    assessment.asOf === "" ||
    !Number.isFinite(evaluatedAtMs)
  ) {
    return null;
  }
  const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
  return Object.freeze({
    attorney_id: assessment.attorneyId,
    jurisdiction_id: assessment.jurisdictionId,
    context_type:
      assessment.practiceAreaId === null
        ? EVALUATION_CONTEXTS.jurisdiction
        : EVALUATION_CONTEXTS.practiceArea,
    context_id: assessment.practiceAreaId,
    evaluated_at: new Date(evaluatedAtMs).toISOString(),
    as_of: assessment.asOf,
    result: assessment.result,
    factor_results: plain(assessment.factors),
    policy_references: plain(assessment.policyReferences),
    evidence_references: plain(assessment.references),
  });
}
