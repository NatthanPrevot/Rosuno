// Professional readiness labels (P3-003).
//
// Presentation only: fixed human wording for the fixed factor, outcome, and
// reason codes the eligibility assessment reports. It decides nothing, and
// an unknown code is shown as recorded rather than guessed at.

import type { Tone } from "./design-system.tsx";

export const FACTOR_LABELS: Readonly<Record<string, string>> = Object.freeze({
  account: "User account",
  profile: "Profile stage",
  policy: "Applicable approved policy",
  license: "License",
  insurance: "Insurance",
  discipline: "Discipline",
  practice_area: "Practice-area authorisation",
});

export const OUTCOME_LABELS: Readonly<
  Record<string, { readonly tone: Tone; readonly label: string }>
> = Object.freeze({
  pass: { tone: "success", label: "Met" },
  fail: { tone: "error", label: "Not met" },
  undetermined: { tone: "warning", label: "Not determined" },
  not_required: { tone: "neutral", label: "Not required by policy" },
  not_applicable: { tone: "neutral", label: "Not applicable" },
});

export const RESULT_LABELS: Readonly<
  Record<string, { readonly tone: Tone; readonly label: string }>
> = Object.freeze({
  eligible: { tone: "success", label: "Eligible" },
  not_eligible: { tone: "error", label: "Not eligible" },
  undetermined: { tone: "warning", label: "Not determined (hold)" },
});

export const REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  facts_unreadable: "The facts could not be read; nothing is assumed.",
  account_active: "The User account is active.",
  account_not_active: "The User account is not active.",
  account_state_unreadable: "The User account state could not be read.",
  profile_approved: "The profile stage is approved (a stage, not eligibility).",
  profile_not_approved: "The profile stage is not approved.",
  profile_suspended_or_removed: "The profile is suspended or removed.",
  profile_unreadable: "The profile could not be read.",
  policy_selected:
    "One approved, active, effective policy with verified authority applies.",
  policy_records_unreadable: "Policy records could not be read.",
  no_applicable_policy:
    "No approved, active, effective policy applies to this jurisdiction.",
  conflicting_policies:
    "More than one policy version applies; nothing is chosen between them.",
  regulatory_mode_undetermined:
    "The applicable policy is mode-specific, and the jurisdiction's regulatory mode is not determined.",
  authority_unverified:
    "The applicable policy has no verified authority reference.",
  policy_parameters_unreadable:
    "The applicable policy's parameters are not in the required form.",
  policy_undetermined:
    "Cannot be assessed until an applicable policy is selected.",
  license_verified:
    "A license in this jurisdiction is supported by current evidence and a qualifying source-observed status.",
  no_license_in_jurisdiction: "No license claim in this jurisdiction.",
  no_record_determined: "No record could be determined.",
  no_record_qualifies: "No record meets the policy.",
  license_expired: "The license claim has expired.",
  license_not_yet_effective: "The license claim is not yet effective.",
  no_evidence: "No verification evidence is linked.",
  evidence_after_assessment:
    "The latest evidence is dated after the assessment time.",
  evidence_stale: "The latest evidence is older than the policy allows.",
  evidence_discrepancy_unresolved:
    "The latest evidence records an unresolved discrepancy.",
  no_source_observation: "No source-observed status is recorded.",
  reported_status_not_qualifying:
    "The source-observed status does not qualify under the policy.",
  insurance_not_required: "The policy does not require insurance.",
  insurance_verified:
    "Insurance in this jurisdiction is current and supported by evidence.",
  no_insurance_in_jurisdiction: "No insurance claim in this jurisdiction.",
  coverage_period_missing: "The coverage period is not stated.",
  coverage_not_current: "The coverage is not current.",
  currency_mismatch: "The limits are in a currency the policy does not state.",
  limit_missing: "A limit the policy requires is not stated.",
  limit_below_minimum: "A limit is below the policy minimum.",
  disqualifying_record:
    "A discipline record has a status the policy treats as disqualifying.",
  record_cleared: "The record's status is one the policy treats as cleared.",
  status_not_classified: "A status is not classified by the policy.",
  no_disqualifying_record_on_file:
    "No disqualifying discipline record is on file (not a clean-record finding).",
  jurisdiction_context: "Assessed for the whole jurisdiction.",
  authorisation_not_required:
    "The policy does not require a practice-area authorisation.",
  no_authorisation: "No authorisation for this practice area.",
  authorisation_current: "The practice-area authorisation is current.",
  authorisation_pending: "The practice-area request is awaiting decision.",
  authorisation_refused: "The practice-area request was not authorised.",
  authorisation_withdrawn: "The practice-area request was withdrawn.",
  authorisation_not_current:
    "The practice-area authorisation is not in effect.",
});

export function reasonLabel(code: string): string {
  return REASON_LABELS[code] ?? "Recorded reason.";
}
