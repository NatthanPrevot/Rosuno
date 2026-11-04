// Professional audit events (P3-003).
//
// The append-only audit_events rows this work item writes, built only from
// values a trusted server operation has already verified. The actor is the
// verified User of the request; the action and resource vocabularies below
// are the fixed codes this work item records. Snapshots hold only the
// professional fields an operation changed, never a credential, session,
// provider detail, or another principal's data. Audit history is evidence,
// not current state: nothing reads it back to decide a lifecycle question.
//
// Write-ahead protocol. The database offers no atomic way to change a
// professional record and append its audit row together (each permitted
// write is one statement on one table, and no function or trigger couples
// them), so ordering carries the guarantee instead: every consequential
// change first appends an "attempt" row naming the actor, resource, and
// intended values, and no domain write runs unless that row is confirmed.
// A persisted change therefore always has its audit evidence. Before each
// write the actor's authority is re-checked afresh, so a revocation, expiry,
// scope change, or deactivation stops the remaining writes; after the writes
// a fresh read decides what actually persisted and a final "outcome" row
// records it, with whether the authority still held at completion. An
// attempt without an applied outcome never asserts that a change happened.

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
  outcome: "audited_change_outcome",
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

// What a fresh read after the writes shows actually persisted.
export type AuditedOutcome =
  "applied" | "partially_applied" | "not_applied" | "unknown";

// The one port the protocol needs: an append that reports the new row.
export type AuditAppend = {
  readonly insertAuditEvent: (event: AuditEvent) => Promise<unknown>;
};

export type AuditedChange = {
  readonly port: AuditAppend;
  // The authorized action, appended before anything is written.
  readonly attempt: AuditInput;
  // A fresh re-check of the actor's authority and the change's
  // preconditions immediately before each write: true holds, false lapsed,
  // null unreadable. Anything but true stops the remaining writes.
  readonly authorizedForWrite: () => Promise<boolean | null>;
  // A fresh re-check of the actor's authority once the writes are done.
  readonly authorizedAtCompletion: () => Promise<boolean | null>;
  // The ordered domain writes. Each answers whether it reported exactly
  // what it wrote; a false or thrown answer stops the remaining writes.
  readonly steps: readonly (() => Promise<boolean>)[];
  // A fresh read deciding what actually persisted.
  readonly verify: () => Promise<AuditedOutcome>;
};

export type AuditedResult =
  // The attempt row could not be confirmed: nothing was written.
  | { readonly status: "unrecorded" }
  // Authority lapsed or could not be read before a write: the remaining
  // writes did not run.
  | {
      readonly status: "stopped";
      readonly authority: "lapsed" | "unreadable";
      readonly outcome: AuditedOutcome;
      readonly outcomeRecorded: boolean;
    }
  | {
      readonly status: "completed";
      readonly outcome: AuditedOutcome;
      readonly authorityAtCompletion: "held" | "lapsed" | "unreadable";
      readonly outcomeRecorded: boolean;
    };

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function settled<T>(call: () => Promise<T>): Promise<T | undefined> {
  try {
    return await call();
  } catch {
    return undefined;
  }
}

// The id of the one row an append reported, or null when the append failed,
// was refused, or its outcome is unknown.
async function appendedId(
  port: AuditAppend,
  event: AuditEvent,
): Promise<string | null> {
  const answer = await settled(() => port.insertAuditEvent(event));
  if (answer === null || typeof answer !== "object") {
    return null;
  }
  const { kind, rows } = answer as { kind?: unknown; rows?: unknown };
  if (kind !== "rows" || !Array.isArray(rows) || rows.length !== 1) {
    return null;
  }
  const id = (rows[0] as { id?: unknown } | null)?.id;
  return typeof id === "string" && UUID_SHAPE.test(id) ? id : null;
}

function authorityOf(answer: boolean | null | undefined) {
  return answer === true ? "held" : answer === false ? "lapsed" : "unreadable";
}

// Runs one consequential change under the write-ahead audit protocol. It
// never throws.
export async function runAuditedChange(
  change: AuditedChange,
  clock: () => number,
): Promise<AuditedResult> {
  const base = change.attempt;
  const attemptId = await appendedId(
    change.port,
    auditEventOf({
      ...base,
      after: { ...(base.after ?? {}), audit_phase: "attempt" },
    }),
  );
  if (attemptId === null) {
    return Object.freeze({ status: "unrecorded" });
  }
  const outcomeOf = async (
    outcome: AuditedOutcome,
    authority: "held" | "lapsed" | "unreadable",
    stage: "before_write" | "at_completion",
  ): Promise<boolean> =>
    (await appendedId(
      change.port,
      auditEventOf({
        actorUserId: base.actorUserId,
        actorType: base.actorType,
        action: AUDIT_ACTIONS.outcome,
        resourceType: base.resourceType,
        resourceId: base.resourceId,
        after: {
          audit_phase: "outcome",
          attempt_event_id: attemptId,
          attempted_action: base.action,
          outcome,
          authority,
          authority_checked: stage,
        },
        jurisdictionId: base.jurisdictionId ?? null,
        occurredAtMs: clock(),
      }),
    )) !== null;
  let written = 0;
  for (const step of change.steps) {
    const authority = authorityOf(await settled(change.authorizedForWrite));
    if (authority !== "held") {
      const outcome: AuditedOutcome =
        written === 0
          ? "not_applied"
          : ((await settled(change.verify)) ?? "unknown");
      return Object.freeze({
        status: "stopped",
        authority,
        outcome,
        outcomeRecorded: await outcomeOf(outcome, authority, "before_write"),
      });
    }
    written += 1;
    if ((await settled(step)) !== true) {
      break;
    }
  }
  const outcome = (await settled(change.verify)) ?? "unknown";
  const authority = authorityOf(await settled(change.authorizedAtCompletion));
  return Object.freeze({
    status: "completed",
    outcome,
    authorityAtCompletion: authority,
    outcomeRecorded: await outcomeOf(outcome, authority, "at_completion"),
  });
}
