// Professional audit vocabulary and atomic write outcomes (P3-003, corrected
// by P3-904).
//
// Every consequential professional change is exactly one call of one
// operation-specific database function, made through the request's own
// authenticated session. The function derives the actor from that session
// (no actor, User, reviewer, or grant is ever passed in), locks and decides
// the actor's current authority, the target's lifecycle stage, and the
// record's version in its own transaction, and writes the domain change and
// its one mandatory audit_events row in that same transaction: both commit,
// or neither does. There is no separate attempt row, no later outcome row,
// and no application-side re-check standing in for the database's decision.
//
// This module holds the fixed audit vocabulary those functions record, which
// the history views read back, and the strict reading of one call's answer.
// Only "applied" means anything changed. A call the database definitely
// refused committed nothing. Anything else (a lost answer, a timeout, a
// malformed reply) is unknown and is never reported as a success.

export const AUDIT_ACTIONS = Object.freeze({
  claimRecorded: "attorney_claim_recorded",
  claimRevised: "attorney_claim_revised",
  profileDetailsRevised: "attorney_profile_details_revised",
  applicationSubmitted: "attorney_application_submitted",
  practiceAreaRequestChanged: "practice_area_request_changed",
  evidenceRecorded: "verification_evidence_recorded",
  sourceUnavailable: "verification_source_unavailable",
  disciplineRecorded: "discipline_record_recorded",
  practiceAreaDecided: "practice_area_authorisation_decided",
  profileStateChanged: "attorney_profile_state_changed",
  informationRequested: "attorney_information_requested",
  eligibilityRecorded: "eligibility_evaluation_recorded",
} as const);

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

// The fixed outcomes a write function returns. applied: the change and its
// audit row committed together. denied: the caller's current identity or
// authority does not allow it. locked: the lifecycle stage or record state
// does not allow it now. conflict: the record changed since it was read, or
// the change would duplicate one already on file. invalid: the database
// refused the submitted values.
export const WRITE_OUTCOMES = Object.freeze([
  "applied",
  "denied",
  "locked",
  "conflict",
  "invalid",
] as const);

export type WriteOutcome = (typeof WRITE_OUTCOMES)[number];

// One write call's answer as the adapter reports it: the function's own
// outcome; "rejected" when the database reported an error for the call (its
// transaction rolled back, so nothing committed); or "unreadable" when the
// answer was lost, late, or malformed, so the outcome is unknown.
export type WriteAnswer =
  | { readonly kind: "outcome"; readonly outcome: WriteOutcome }
  | { readonly kind: "rejected" }
  | { readonly kind: "unreadable" };

export type WriteResult = WriteOutcome | "rejected" | "unknown";

function ownField(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

// The one answer of one write call, read strictly, or "unknown".
export function writeResultOf(answer: unknown): WriteResult {
  try {
    if (answer === null || typeof answer !== "object") {
      return "unknown";
    }
    const keys = Reflect.ownKeys(answer);
    const kind = ownField(answer, "kind");
    if (kind === "rejected" && keys.length === 1) {
      return "rejected";
    }
    const outcome = ownField(answer, "outcome");
    return kind === "outcome" &&
      keys.length === 2 &&
      WRITE_OUTCOMES.some((entry) => entry === outcome)
      ? (outcome as WriteOutcome)
      : "unknown";
  } catch {
    return "unknown";
  }
}

// Runs one write call. A thrown call is an unknown outcome, never an answer.
export async function writeOnce(
  call: () => Promise<WriteAnswer>,
): Promise<WriteResult> {
  try {
    return writeResultOf(await call());
  } catch {
    return "unknown";
  }
}
