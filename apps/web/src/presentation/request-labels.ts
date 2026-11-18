// Consultation Request labels (MVP-001 S6).
//
// Fixed, plain wording for the request review, the request page and the
// Intake's requests. Nothing here recommends, ranks or matches an attorney
// (MBS section 10; Packet rule 11), claims a live or approved regulatory
// status (MBS section 17), writes legal text, or describes a payment step
// (payments belong to S7). Modalities are configuration: a modality code is
// shown as its words, never translated through a fixed list. Amounts come
// from the database in minor units and are shown with their currency code;
// instants come from the database and are shown in UTC. The server decides
// every expiry; these labels only show what it reports. MVP-001 S6 PS-A3: the
// optional message's wording, its maximum (from the database) and its count.

import type {
  RequestActionState,
  RequestPath,
  RequestState,
  WithdrawActionState,
} from "../application/consultation-request.ts";
import type { Tone } from "./design-system.tsx";

export const REQUEST_STATE_LABELS: Readonly<
  Record<RequestState, { readonly label: string; readonly tone: Tone }>
> = Object.freeze({
  created: { label: "Requested", tone: "information" },
  payment_authorized: { label: "In progress", tone: "information" },
  slot_held: { label: "Requested, time held", tone: "information" },
  awaiting_attorney: { label: "Waiting for the attorney", tone: "information" },
  accepted: { label: "Accepted", tone: "success" },
  declined: { label: "Declined", tone: "neutral" },
  expired: { label: "Expired", tone: "warning" },
  cancelled: { label: "Withdrawn", tone: "neutral" },
});

export const REQUEST_PATH_LABELS: Readonly<Record<RequestPath, string>> =
  Object.freeze({
    instant: "As soon as possible (available now)",
    scheduled: "At a scheduled time",
  });

// A modality code in words: underscores as spaces, the first letter capital.
export function modalityText(code: string): string {
  const words = code.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function durationText(minutes: number): string {
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

// An amount in minor units with its currency code, using the currency's own
// number of decimal places.
export function moneyText(minor: number, currency: string): string {
  const format = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    currencyDisplay: "code",
  });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(minor / 10 ** digits);
}

export function utcText(timestamp: string): string {
  return `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function validityText(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  const minutes = Math.floor(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export const REVIEW_NOTE =
  "Choose how and for how long you want to meet. The price is calculated when you confirm and stays fixed for this request.";

export const PRICING_NOT_AVAILABLE =
  "This attorney's consultation pricing is not yet available, so a request cannot be made.";

export const CHOOSE_OPTION = "Choose a consultation option.";

export const CHOOSE_TIME =
  "Choose a start time. Times are in UTC; only open times are offered.";

export const NO_TIMES =
  "No open start time is offered for this option right now. Choose another option or try again later.";

export const INVALID_CHOICE =
  "The choice is not one of the options offered. Choose again from the list.";

export const NOT_REQUESTABLE =
  "A request cannot be made from this selection. The selection may already have an outcome, or its Intake may no longer be open.";

export const ALREADY_REQUESTED =
  "A request was already made from this selection.";

export const SERVER_TIME_NOTE =
  "Times are in UTC. Rosuno's server decides when a request expires; this page only shows it.";

export const QUOTE_NOTE =
  "If you confirm, this price is fixed for your request and is held until the time shown on your request.";

export const MESSAGE_LABEL = "Message (optional)";

export function messageHint(maximum: number): string {
  return `Plain text, up to ${maximum} characters. It is kept with your request as you write it.`;
}

export function messageCount(used: number, maximum: number): string {
  return `${used} of ${maximum} characters`;
}

export function messageOverBy(over: number): string {
  return over === 1
    ? "Your message is 1 character too long. Shorten it to continue."
    : `Your message is ${over} characters too long. Shorten it to continue.`;
}

export const NO_MESSAGE = "A message cannot be added to this request.";

export const YOUR_MESSAGE = "Your message";

export const EXPIRED_NOTE =
  "This request has expired. Its price cannot be used again. To try again, select an attorney again from your Intake.";

export function quoteStatusText(
  status:
    | "pricing-unavailable"
    | "option-unavailable"
    | "configuration-unavailable"
    | "not-available"
    | "unavailable",
): string {
  switch (status) {
    case "pricing-unavailable":
      return PRICING_NOT_AVAILABLE;
    case "option-unavailable":
      return "This option is not available for this attorney. Choose another option.";
    case "configuration-unavailable":
      return "Requests cannot be made in this jurisdiction right now.";
    case "not-available":
      return NOT_REQUESTABLE;
    case "unavailable":
      return "The price could not be shown right now. Please try again later.";
  }
}

export function requestMessage(state: RequestActionState): {
  readonly tone: Tone;
  readonly title: string;
  readonly body: string;
} | null {
  switch (state.status) {
    case "idle":
      return null;
    case "created":
      return {
        tone: "success",
        title: "Your request is made",
        body: "Your request is recorded with its fixed price.",
      };
    case "invalid":
      return {
        tone: "error",
        title: "Check your choice",
        body: "The request did not match what was offered. Review your choice and try again.",
      };
    case "not-found":
      return {
        tone: "error",
        title: "Selection not found",
        body: "That selection was not found in your workspace.",
      };
    case "intake-not-ready":
      return {
        tone: "warning",
        title: "This Intake cannot be used",
        body: "Only a submitted Intake that is still open can be used to request a consultation.",
      };
    case "already-requested":
      return {
        tone: "warning",
        title: "Already requested",
        body: ALREADY_REQUESTED,
      };
    case "slot-unavailable":
      return {
        tone: "warning",
        title: "That time is no longer available",
        body: "Nothing was requested. Choose another start time.",
      };
    case "not-available":
      return {
        tone: "warning",
        title: "This attorney cannot be requested right now",
        body: "This attorney is not currently available for what you chose. Nothing was requested.",
      };
    case "option-unavailable":
      return {
        tone: "warning",
        title: "This option is not available",
        body: "This option is not available for this attorney. Nothing was requested. Choose another option.",
      };
    case "pricing-unavailable":
      return {
        tone: "warning",
        title: "Pricing not available",
        body: `${PRICING_NOT_AVAILABLE} Nothing was requested.`,
      };
    case "configuration-unavailable":
      return {
        tone: "warning",
        title: "Requests are not available",
        body: "Requests cannot be made in this jurisdiction right now. Nothing was requested.",
      };
    case "message-not-permitted":
      return {
        tone: "warning",
        title: "A message cannot be added",
        body: `${NO_MESSAGE} Nothing was requested. Remove the message and try again.`,
      };
    case "message-too-long":
      return {
        tone: "warning",
        title: "Your message is too long",
        body: "Nothing was requested. Shorten your message to the number of characters shown and try again.",
      };
    case "cap-reached":
      return {
        tone: "warning",
        title: "This attorney cannot take another request now",
        body: "This attorney has the most pending requests allowed. Nothing was requested. Try again later.",
      };
    case "outcome-unknown":
      return {
        tone: "warning",
        title: "We could not confirm your request",
        body: "Your request may or may not have been made. Check your Intake before trying again.",
      };
    case "sign-in-required":
      return {
        tone: "error",
        title: "Sign in to continue",
        body: "Sign in to your client account to request a consultation.",
      };
    case "denied":
      return {
        tone: "error",
        title: "Not available for this account",
        body: "Requesting a consultation is available to signed-in client accounts.",
      };
    case "unavailable":
      return {
        tone: "error",
        title: "Something went wrong",
        body: "Your request could not be made right now. Please try again later.",
      };
  }
}

export function withdrawMessage(state: WithdrawActionState): {
  readonly tone: Tone;
  readonly title: string;
  readonly body: string;
} | null {
  switch (state.status) {
    case "idle":
      return null;
    case "withdrawn":
      return {
        tone: "success",
        title: "Request withdrawn",
        body: "Your request is withdrawn.",
      };
    case "expired":
      return {
        tone: "warning",
        title: "Request expired",
        body: "This request had already expired, so there is nothing to withdraw.",
      };
    case "not-withdrawable":
      return {
        tone: "warning",
        title: "Cannot be withdrawn",
        body: "This request can no longer be withdrawn.",
      };
    case "not-found":
      return {
        tone: "error",
        title: "Request not found",
        body: "That request was not found in your workspace.",
      };
    case "invalid":
      return {
        tone: "error",
        title: "Something was wrong with the form",
        body: "Reload the page and try again.",
      };
    case "outcome-unknown":
      return {
        tone: "warning",
        title: "We could not confirm the withdrawal",
        body: "Your request may or may not have been withdrawn. Reload the page to check.",
      };
    case "sign-in-required":
      return {
        tone: "error",
        title: "Sign in to continue",
        body: "Sign in to your client account to manage your request.",
      };
    case "denied":
      return {
        tone: "error",
        title: "Not available for this account",
        body: "Managing a request is available to signed-in client accounts.",
      };
    case "unavailable":
      return {
        tone: "error",
        title: "Something went wrong",
        body: "Your request could not be withdrawn right now. Please try again later.",
      };
  }
}
