// Professional audit events (P3-003).
//
// The append-only audit_events rows this work item writes, built only from
// values a trusted server operation has already verified. The actor is the
// verified User of the request; the action and resource vocabularies below
// are the fixed codes this work item records. Snapshots hold only the
// professional fields an operation changed, never a credential, session,
// provider detail, or another principal's data. Audit history is evidence,
// not current state: nothing reads it back to decide a lifecycle question.

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

export type AuditResource =
  | "attorney_profile"
  | "license"
  | "insurance_record"
  | "discipline_record"
  | "practice_area_authorisation"
  | "verification_evidence"
  | "eligibility_evaluation";

export type AuditActorType = "attorney" | "staff";

// One audit_events row, exactly as the privileged port inserts it.
export type AuditEvent = {
  readonly actor_user_id: string;
  readonly actor_type: AuditActorType;
  readonly action_code: AuditAction;
  readonly resource_type: AuditResource;
  readonly resource_id: string;
  readonly before_snapshot: Readonly<Record<string, unknown>> | null;
  readonly after_snapshot: Readonly<Record<string, unknown>> | null;
  readonly reason_code: string | null;
  readonly policy_references: readonly unknown[] | null;
  readonly jurisdiction_id: string | null;
  readonly occurred_at: string;
};

export type AuditInput = {
  readonly actorUserId: string;
  readonly actorType: AuditActorType;
  readonly action: AuditAction;
  readonly resourceType: AuditResource;
  readonly resourceId: string;
  readonly before?: Readonly<Record<string, unknown>> | null;
  readonly after?: Readonly<Record<string, unknown>> | null;
  readonly reasonCode?: string | null;
  readonly policyReferences?: readonly unknown[] | null;
  readonly jurisdictionId?: string | null;
  readonly occurredAtMs: number;
};

// A frozen audit row of plain JSON values.
export function auditEventOf(input: AuditInput): AuditEvent {
  const plain = <T>(value: T): T =>
    value === null || value === undefined
      ? (null as T)
      : (JSON.parse(JSON.stringify(value)) as T);
  return Object.freeze({
    actor_user_id: input.actorUserId,
    actor_type: input.actorType,
    action_code: input.action,
    resource_type: input.resourceType,
    resource_id: input.resourceId,
    before_snapshot: plain(input.before ?? null),
    after_snapshot: plain(input.after ?? null),
    reason_code: input.reasonCode ?? null,
    policy_references: plain(input.policyReferences ?? null),
    jurisdiction_id: input.jurisdictionId ?? null,
    occurred_at: new Date(input.occurredAtMs).toISOString(),
  });
}
