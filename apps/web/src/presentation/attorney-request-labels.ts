// Attorney request labels (MVP-001 S8).
//
// Fixed, plain wording for the attorney's request queue, one request and the
// decision on it. Nothing here recommends, ranks or matches anyone (MBS
// section 10; Packet rule 11), claims a live or approved regulatory status
// (MBS section 17), writes legal text or engagement terms (MB section 47:
// counsel review), or describes the client: before acceptance the attorney is
// shown nothing about the client or what they need help with (Packet section
// 3: counsel gate). Modalities are configuration: a modality code is shown as
// its words. Amounts come from the database in minor units with their
// currency code; instants come from the database and are shown in UTC. The
// server decides every expiry; these labels only show what it reports.

import type {
  AttorneyDisplayState,
  AttorneyRequestPath,
  ConsultationState,
  DecisionActionState,
  DecisionOutcome,
} from "../application/attorney-requests.ts";
import type { Tone } from "./design-system.tsx";

export {
  durationText,
  modalityText,
  moneyText,
  utcText,
} from "./request-labels.ts";

export const ATTORNEY_REQUEST_STATE_LABELS: Readonly<
  Record<AttorneyDisplayState, { readonly label: string; readonly tone: Tone }>
> = Object.freeze({
  awaiting_attorney: {
    label: "Waiting for your decision",
    tone: "information",
  },
  accepted: { label: "Accepted", tone: "success" },
  declined: { label: "Declined", tone: "neutral" },
  expired: { label: "Expired", tone: "warning" },
  cancelled: { label: "Withdrawn by the client", tone: "neutral" },
  could_not_proceed: { label: "Could not go ahead", tone: "warning" },
});

export const ATTORNEY_REQUEST_PATH_LABELS: Readonly<
  Record<AttorneyRequestPath, string>
> = Object.freeze({
  instant: "As soon as possible",
  scheduled: "At a scheduled time",
});

export const CONSULTATION_STATE_LABELS: Readonly<
  Record<ConsultationState, string>
> = Object.freeze({
  created: "Being set up",
  scheduled: "Scheduled",
  ready: "Ready",
  live: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "Did not take place",
  technical_failure: "Could not take place",
});

export const QUEUE_INTRO =
  "Requests waiting for your decision. Each shows only the consultation asked for and its timing; nothing about the client is shown before you accept.";

export const NO_REQUESTS = "No request is waiting for your decision.";

export const DETAIL_NOTE =
  "Nothing about the client is shown before you accept. The price was fixed when the request was made and does not change.";

export const DECIDE_BY_NOTE =
  "Times are in UTC. Rosuno's server decides when a request expires; this page only shows it.";

export const EXPIRED_REQUEST_NOTE =
  "This request has expired and can no longer be decided.";

export const ACCEPTED_NOTE =
  "You accepted this request. The consultation is shown below as Rosuno recorded it.";

export const CONSULTATION_PENDING_NOTE =
  "You accepted this request. The consultation is set up once its payment step completes.";

export const ACCEPT_LABEL = "Accept request";
export const DECLINE_LABEL = "Decline request";

export const DECISION_OUTCOME_MESSAGES: Readonly<
  Record<
    DecisionOutcome,
    { readonly tone: Tone; readonly title: string; readonly body: string }
  >
> = Object.freeze({
  request_accepted: {
    tone: "success",
    title: "Request accepted",
    body: "The request is accepted. The consultation is shown on this page as Rosuno recorded it.",
  },
  request_declined: {
    tone: "success",
    title: "Request declined",
    body: "The request is declined and its time is released.",
  },
  not_found: {
    tone: "error",
    title: "Request not found",
    body: "That request was not found among your requests.",
  },
  expired: {
    tone: "warning",
    title: "Request expired",
    body: "This request had already expired, so it can no longer be decided.",
  },
  withdrawn: {
    tone: "warning",
    title: "Request withdrawn",
    body: "The client withdrew this request, so it can no longer be decided.",
  },
  already_decided: {
    tone: "information",
    title: "Already decided",
    body: "This request was already decided. Reload the page to see its outcome.",
  },
  configuration_unavailable: {
    tone: "warning",
    title: "Decisions are not available",
    body: "Requests cannot be accepted in this jurisdiction right now. Nothing was changed.",
  },
  payment_not_ready: {
    tone: "warning",
    title: "Payment step not complete",
    body: "This request cannot be accepted until its payment step is complete. Nothing was changed.",
  },
  not_eligible: {
    tone: "warning",
    title: "Request could not go ahead",
    body: "This request could not go ahead at the time of your decision, so it has ended. Your professional records are shown in professional setup.",
  },
  eligibility_unavailable: {
    tone: "error",
    title: "Could not be checked",
    body: "The request could not be checked right now. Nothing was changed. Please try again later.",
  },
  not_bookable: {
    tone: "warning",
    title: "Not available for this request",
    body: "This request cannot be accepted because your availability for it has changed. Nothing was accepted; you can decline it.",
  },
  conflict: {
    tone: "error",
    title: "Could not be completed",
    body: "The decision could not be completed. Nothing was changed. Reload the page and try again.",
  },
});

export function decisionMessage(state: DecisionActionState): {
  readonly tone: Tone;
  readonly title: string;
  readonly body: string;
} | null {
  switch (state.status) {
    case "idle":
      return null;
    case "outcome":
      return DECISION_OUTCOME_MESSAGES[state.outcome];
    case "invalid":
      return {
        tone: "error",
        title: "Something was wrong with the form",
        body: "Reload the page and try again.",
      };
    case "unconfirmed":
      return {
        tone: "error",
        title: "The decision could not be confirmed",
        body: "Your decision may or may not have been recorded. Reload the page to see the request before trying again.",
      };
    case "sign-in-required":
      return {
        tone: "warning",
        title: "Sign in again",
        body: "Your session has ended. Sign in again to continue.",
      };
    case "denied":
      return {
        tone: "warning",
        title: "Not available",
        body: "This decision is not available for this account.",
      };
    case "unavailable":
      return {
        tone: "error",
        title: "Unavailable",
        body: "This could not be completed right now. Please try again later.",
      };
    case "step-up-required":
      return {
        tone: "warning",
        title: "Confirm your sign-in",
        body: "Nothing was sent. This decision needs a sign-in confirmed with a code from your authenticator app. Reload this page to confirm it, then try again.",
      };
    default:
      return null;
  }
}
