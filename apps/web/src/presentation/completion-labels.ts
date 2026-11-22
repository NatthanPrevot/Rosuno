// Completion workspace labels (MVP-001 S11).
//
// Fixed, plain wording for how a Consultation ended, cancellation, early
// completion by agreement, the staff consultation operations, Verified Client
// Reviews, reported problems (Complaint Cases) and Legal Holds. Nothing here
// recommends, ranks or matches anyone (MBS section 10; Packet rule 11),
// claims a regulatory status (MBS section 17), writes legal text (MB section
// 47: counsel review), promises a refund or a charge (the financial treatment
// of a cancellation, a no-show or a failure is decided by a person, never
// here), or describes either participant. The server decides every state,
// outcome and time; these labels only show what it reports (instants in
// UTC). The consultation room provider is never named.

import type { ActionState } from "../application/workspace-support.ts";
import type {
  CancelActionOutcome,
  EndEarlyActionOutcome,
  OutcomeCode,
  RecordActionOutcome,
  ReviewFamily,
  ReviewItemActionOutcome,
  StaffOutcomeCode,
  WindowBasis,
} from "../application/consultation-outcomes.ts";
import type {
  CaseAction,
  CaseActionOutcome,
  ComplaintState,
  OpenActionOutcome,
} from "../application/complaints.ts";
import type {
  HoldActionOutcome,
  HoldScope,
  HoldStatus,
} from "../application/legal-holds.ts";
import type {
  ModerateActionOutcome,
  ReviewState,
  SubmitActionOutcome,
} from "../application/reviews.ts";
import type { Tone } from "./design-system.tsx";

export { utcText } from "./request-labels.ts";

export type Message = {
  readonly tone: Tone;
  readonly title: string;
  readonly body: string;
};

// How a Consultation ended (its recorded completion reason).
export const OUTCOME_LABELS: Readonly<Record<OutcomeCode, string>> =
  Object.freeze({
    normal: "Completed by the attorney",
    early_by_agreement: "Ended early by agreement, as recorded by the attorney",
    manual_resolution: "Recorded as completed by Rosuno staff",
    client_cancelled: "Cancelled by the client",
    attorney_cancelled: "Cancelled by the attorney",
    client_no_show: "Recorded by Rosuno staff: the client did not attend",
    attorney_no_show: "Recorded by Rosuno staff: the attorney did not attend",
    both_no_show: "Recorded by Rosuno staff: neither participant attended",
    neither_connected:
      "Recorded by Rosuno staff: neither participant could connect",
    mid_consultation_failure:
      "Recorded by Rosuno staff: ended by a technical problem during the consultation",
  });

export function outcomeLabelOf(code: string | null): string | null {
  return code !== null && Object.hasOwn(OUTCOME_LABELS, code)
    ? OUTCOME_LABELS[code as OutcomeCode]
    : null;
}

// What staff may record, in the outcome command.
export const STAFF_OUTCOME_LABELS: Readonly<Record<StaffOutcomeCode, string>> =
  Object.freeze({
    client_no_show: "The client did not attend",
    attorney_no_show: "The attorney did not attend",
    both_no_show: "Neither participant attended",
    neither_connected: "Neither participant could connect (technical failure)",
    manual_resolution: "The consultation took place (completed)",
    mid_consultation_failure:
      "The consultation was ended by a technical problem",
  });

export const WINDOW_BASIS_LABELS: Readonly<Record<WindowBasis, string>> =
  Object.freeze({
    configured: "the end of the consultation's permitted time",
    fail_safe:
      "the safe fallback (the scheduled end plus one day), because the permitted time is not configured",
    unavailable: "not available: the consultation's end cannot be derived",
  });

export const CLIENT_GROUPS = Object.freeze([
  { key: "active", title: "Now" },
  { key: "upcoming", title: "Upcoming" },
  { key: "ended", title: "Ended" },
  { key: "cancelled", title: "Cancelled" },
] as const);

export const FAMILY_TITLES: Readonly<Record<ReviewFamily, string>> =
  Object.freeze({
    operations: "Operations review items",
    compliance: "Compliance review items",
  });

export const REVIEW_STATE_LABELS: Readonly<
  Record<ReviewState, { readonly label: string; readonly tone: Tone }>
> = Object.freeze({
  submitted: { label: "Submitted, waiting for review", tone: "information" },
  published: { label: "Published", tone: "success" },
  rejected: { label: "Not published", tone: "neutral" },
});

export const COMPLAINT_STATE_LABELS: Readonly<
  Record<ComplaintState, { readonly label: string; readonly tone: Tone }>
> = Object.freeze({
  opened: { label: "Received", tone: "information" },
  in_review: { label: "In review", tone: "information" },
  escalated: { label: "Escalated", tone: "warning" },
  resolved: { label: "Resolved", tone: "neutral" },
});

export const CASE_ACTION_LABELS: Readonly<Record<CaseAction, string>> =
  Object.freeze({
    assign: "Assign to me",
    unassign: "Clear assignment",
    escalate: "Escalate",
    return_to_review: "Return to review",
  });

export const HOLD_SCOPE_LABELS: Readonly<Record<HoldScope, string>> =
  Object.freeze({
    consultation: "Consultation",
    intake: "Intake",
    resource: "Document or file",
    complaint_case: "Reported problem",
    user: "User",
  });

export const HOLD_STATUS_LABELS: Readonly<Record<HoldStatus, string>> =
  Object.freeze({
    active: "In force",
    released: "Released",
  });

export const RATING_LABELS: Readonly<Record<number, string>> = Object.freeze({
  1: "1 of 5",
  2: "2 of 5",
  3: "3 of 5",
  4: "4 of 5",
  5: "5 of 5",
});

export const REVIEW_NOTE =
  "Only clients of a completed consultation can review it, once. A review is published only after Rosuno reviews it. Your name is never shown with it.";
export const PUBLIC_REVIEWS_NOTE =
  "Reviews come from clients of completed consultations and are published after review. The count and average cover every published review.";
export const COMPLAINT_NOTE =
  "Reporting a problem does not change a consultation or a payment. Rosuno reviews every report; the other participant does not see it.";
export const CANCEL_NOTE =
  "You can cancel before the consultation starts. The other participant is told. Any payment is reviewed by Rosuno staff; nothing is refunded or charged automatically here.";
// MVP-001 S11 correction pass (A7): the cancellation is asked for in two
// steps; the second sends it.
export const CANCEL_LABEL = "Cancel the consultation";
export const CANCEL_CONFIRM_PROMPT =
  "Please confirm that you want to cancel this consultation.";
export const CANCEL_CONFIRM_LABEL = "Confirm the cancellation";
export const CANCEL_KEEP_LABEL = "Keep the consultation";
export const END_EARLY_NOTE =
  "End early only when you and the client agree. The client is told the recorded outcome.";
export const HOLD_NOTE =
  "A Legal Hold stops the deletion of the records it covers and changes nothing else. Its reason is kept on the hold only.";
export const OPERATIONS_NOTE =
  "Only consultations whose time has passed are listed. Record an outcome from the attendance evidence; nothing is decided automatically.";

const SHARED = Object.freeze({
  sign_in: {
    tone: "warning",
    title: "Sign in again",
    body: "Your session has ended. Sign in again to continue.",
  },
  denied: {
    tone: "warning",
    title: "Not available",
    body: "This is not available for this account.",
  },
  unavailable: {
    tone: "error",
    title: "Unavailable",
    body: "This could not be completed right now. Nothing was changed. Please try again later.",
  },
  step_up: {
    tone: "warning",
    title: "Confirm your sign-in",
    body: "Nothing was sent. This needs a sign-in confirmed with a code from your authenticator app. Reload this page to confirm it, then try again.",
  },
  invalid: {
    tone: "warning",
    title: "Check the form",
    body: "Something in the form is missing or not valid. Nothing was sent.",
  },
  unconfirmed: {
    tone: "error",
    title: "Could not be confirmed",
    body: "The answer could not be confirmed. Reload the page to see the current state before trying again.",
  },
} satisfies Record<string, Message>);

// The fixed message of an action state through the action's own table.
export function messageOf<Outcome extends string>(
  state: ActionState<Outcome>,
  table: Readonly<Record<Outcome, Message>>,
): Message | null {
  switch (state.status) {
    case "idle":
      return null;
    case "outcome":
      return table[state.outcome];
    case "invalid":
      return SHARED.invalid;
    case "unconfirmed":
      return SHARED.unconfirmed;
    case "sign-in-required":
      return SHARED.sign_in;
    case "denied":
      return SHARED.denied;
    case "unavailable":
      return SHARED.unavailable;
    case "step-up-required":
      return SHARED.step_up;
    default:
      return null;
  }
}

const NOT_FOUND = {
  tone: "warning",
  title: "Not found",
  body: "This could not be found. Nothing was changed.",
} as const;

export const CANCEL_MESSAGES: Readonly<Record<CancelActionOutcome, Message>> =
  Object.freeze({
    consultation_cancelled: {
      tone: "success",
      title: "Consultation cancelled",
      body: "The consultation is cancelled and the other participant is told. Any payment is reviewed by Rosuno staff.",
    },
    not_found: NOT_FOUND,
    already_cancelled: {
      tone: "neutral",
      title: "Already cancelled",
      body: "This consultation was already cancelled. Nothing was changed.",
    },
    ended: {
      tone: "neutral",
      title: "Already ended",
      body: "This consultation has already ended. Nothing was changed.",
    },
    in_progress: {
      tone: "warning",
      title: "Already started",
      body: "This consultation has started, so it can no longer be cancelled. Nothing was changed.",
    },
    configuration_unavailable: {
      tone: "error",
      title: "Not available right now",
      body: "This cannot be done right now. Nothing was changed.",
    },
    // MVP-001 S11 review correction R2.
    time_passed: {
      tone: "warning",
      title: "The scheduled time has passed",
      body: "This consultation can no longer be cancelled. Rosuno staff record what happened. Nothing was changed.",
    },
  });

export const END_EARLY_MESSAGES: Readonly<
  Record<EndEarlyActionOutcome, Message>
> = Object.freeze({
  consultation_completed_early: {
    tone: "success",
    title: "Consultation ended early",
    body: "The consultation has ended early by agreement and the room is closing. The client is told.",
  },
  not_found: NOT_FOUND,
  not_started: {
    tone: "information",
    title: "Not started",
    body: "This consultation has not started. Nothing was changed.",
  },
  ended: {
    tone: "neutral",
    title: "Already ended",
    body: "This consultation has already ended. Nothing was changed.",
  },
  not_early: {
    tone: "information",
    title: "The scheduled time is over",
    body: "The consultation's scheduled time is over, so it is not an early end. End the consultation normally instead. Nothing was changed.",
  },
  configuration_unavailable: {
    tone: "error",
    title: "Not available right now",
    body: "This cannot be done right now. Nothing was changed.",
  },
  conflict: {
    tone: "error",
    title: "Could not be completed",
    body: "The consultation could not be ended right now. Nothing was changed. Please try again.",
  },
});

export const RECORD_MESSAGES: Readonly<Record<RecordActionOutcome, Message>> =
  Object.freeze({
    outcome_recorded: {
      tone: "success",
      title: "Outcome recorded",
      body: "The outcome is recorded and both participants are told. Any payment consequence is applied or opened as a review item.",
    },
    not_found: NOT_FOUND,
    already_decided: {
      tone: "neutral",
      title: "Already decided",
      body: "This consultation already has an outcome. Nothing was changed.",
    },
    not_applicable: {
      tone: "warning",
      title: "Not for this consultation",
      body: "This outcome does not apply to the consultation in its current state. Nothing was changed.",
    },
    window_open: {
      tone: "information",
      title: "Too early",
      body: "The participants can still proceed, so no outcome can be recorded yet. Nothing was changed.",
    },
    window_unavailable: {
      tone: "warning",
      title: "Cannot be decided",
      body: "The consultation's end cannot be derived, so no outcome can be recorded. Nothing was changed.",
    },
    evidence_conflict: {
      tone: "warning",
      title: "The attendance evidence disagrees",
      body: "This outcome contradicts what the consultation room recorded. Confirm that you have checked the evidence to record it anyway. Nothing was changed.",
    },
    configuration_unavailable: {
      tone: "error",
      title: "Not available right now",
      body: "This cannot be done right now. Nothing was changed.",
    },
    conflict: {
      tone: "error",
      title: "Could not be completed",
      body: "The outcome could not be recorded right now. Nothing was changed. Please try again.",
    },
  });

export const REVIEW_ITEM_MESSAGES: Readonly<
  Record<ReviewItemActionOutcome, Message>
> = Object.freeze({
  applied: {
    tone: "success",
    title: "Saved",
    body: "The review item is updated.",
  },
  not_found: NOT_FOUND,
  invalid_transition: {
    tone: "neutral",
    title: "Already changed",
    body: "This review item has already changed. Nothing was changed.",
  },
});

export const SUBMIT_MESSAGES: Readonly<Record<SubmitActionOutcome, Message>> =
  Object.freeze({
    review_submitted: {
      tone: "success",
      title: "Review submitted",
      body: "Thank you. Your review is published only after Rosuno reviews it.",
    },
    not_eligible: {
      tone: "warning",
      title: "Cannot be reviewed",
      body: "This consultation cannot be reviewed. Nothing was sent.",
    },
    already_reviewed: {
      tone: "neutral",
      title: "Already reviewed",
      body: "This consultation already has your review. Nothing was changed.",
    },
  });

export const MODERATE_MESSAGES: Readonly<
  Record<ModerateActionOutcome, Message>
> = Object.freeze({
  applied: {
    tone: "success",
    title: "Saved",
    body: "The review is updated.",
  },
  not_found: NOT_FOUND,
  invalid_transition: {
    tone: "neutral",
    title: "Already changed",
    body: "This review has already changed. Nothing was changed.",
  },
});

export const OPEN_MESSAGES: Readonly<Record<OpenActionOutcome, Message>> =
  Object.freeze({
    complaint_opened: {
      tone: "success",
      title: "Problem reported",
      body: "Your report is received. Rosuno reviews it; nothing about the consultation or its payment changes.",
    },
    not_found: NOT_FOUND,
    already_open: {
      tone: "neutral",
      title: "Already reported",
      body: "You already have an open report about this. Nothing was changed.",
    },
  });

export const CASE_MESSAGES: Readonly<Record<CaseActionOutcome, Message>> =
  Object.freeze({
    applied: {
      tone: "success",
      title: "Saved",
      body: "The case is updated.",
    },
    not_found: NOT_FOUND,
    invalid_transition: {
      tone: "neutral",
      title: "Not possible now",
      body: "The case cannot change this way in its current state. Nothing was changed.",
    },
    configuration_unavailable: {
      tone: "warning",
      title: "Not configured",
      body: "The categories and resolutions of reported problems are not configured yet. Nothing was changed.",
    },
    invalid_code: {
      tone: "warning",
      title: "Unknown code",
      body: "This code is not in the configured list. Nothing was changed.",
    },
  });

export const HOLD_MESSAGES: Readonly<Record<HoldActionOutcome, Message>> =
  Object.freeze({
    hold_placed: {
      tone: "success",
      title: "Legal Hold placed",
      body: "The Legal Hold is in force.",
    },
    hold_released: {
      tone: "success",
      title: "Legal Hold released",
      body: "The Legal Hold is released.",
    },
    not_found: NOT_FOUND,
    already_released: {
      tone: "neutral",
      title: "Already released",
      body: "This Legal Hold was already released. Nothing was changed.",
    },
  });
