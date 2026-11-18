// Discovery and selection labels (MVP-001 S5).
//
// Fixed, plain wording for the public directory, the public profile, the
// selection page and the client's attempts. No wording here recommends,
// ranks or matches an attorney (MBS section 10; MB section 28): the order is
// named for what it is, and the client chooses. No wording claims that any
// regulatory status is live or approved (MBS section 17), and no legal text
// is written here (MVP-001 Packet rule 11). Instants come from the database
// and are shown in UTC.

import type {
  AvailabilityFilter,
  RequestPath,
  SelectionActionState,
} from "../application/discovery.ts";
import type { Tone } from "./design-system.tsx";

export const AVAILABILITY_LABELS: Readonly<Record<AvailabilityFilter, string>> =
  Object.freeze({
    any: "Any availability",
    instant: "Available now",
    scheduled: "Scheduled availability in the next 14 days",
  });

export const PATH_LABELS: Readonly<Record<RequestPath, string>> = Object.freeze(
  {
    instant: "As soon as possible (available now)",
    scheduled: "At a scheduled time",
  },
);

export const ATTEMPT_PATH_LABELS: Readonly<Record<RequestPath, string>> =
  Object.freeze({
    instant: "Available now",
    scheduled: "Scheduled",
  });

// The directory's one order, named for what it is.
export const ORDER_LABEL = "Sorted by name";

export const DIRECTORY_NOTE =
  "Attorneys are listed by name. Use the filters to narrow the list, and choose for yourself.";

export const CHOOSE_PROMPT =
  "Choose a jurisdiction to see the attorneys listed there.";

export const INVALID_PROMPT =
  "One of the filters is not one of the listed choices. Choose from the lists and search again.";

export const NO_RESULTS = "No attorney matches these filters right now.";

export const NO_JURISDICTIONS =
  "No attorney is listed in any jurisdiction right now.";

export const AVAILABLE_NOW = "Available now";
export const SCHEDULED_AVAILABILITY = "Scheduled availability";
export const NO_AVAILABILITY_SHOWN = "No availability shown";

export const NO_WINDOWS =
  "No open times in the next 14 days are shown for this jurisdiction.";

export const WINDOWS_NOTE =
  "Open times in the next 14 days, in UTC. Choosing a time comes later.";

export const PROFILE_JURISDICTION_NOTE =
  "Choose a jurisdiction in the directory to see open times there.";

export function yearsText(years: number | null): string | null {
  if (years === null) {
    return null;
  }
  return years === 1 ? "1 year of experience" : `${years} years of experience`;
}

export function utcText(timestamp: string): string {
  return `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export const SELECTION_NOTE =
  "You choose which attorney to select. Selecting records your choice for one of your Intakes; nothing is sent to the attorney yet.";

export const CONSULTATION_NOT_AVAILABLE =
  "Requesting a consultation is not yet available.";

export const NO_OPEN_INTAKES =
  "You have no submitted Intake to select an attorney for. Submit an Intake in your client workspace first.";

export const MORE_INTAKES_NOTE =
  "Only your 20 most recent Intakes are offered here.";

export const ATTEMPTS_NOTE =
  "Each time you select an attorney for this Intake, the selection is listed here.";

export const NO_ATTEMPTS = "You have not selected an attorney for this Intake.";

export const OUTCOME_RECORDED = "Outcome recorded";
export const NO_OUTCOME = "No outcome yet";

export function selectionMessage(state: SelectionActionState): {
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
        title: "Your selection is recorded",
        body: `Your selection is recorded for your Intake. ${CONSULTATION_NOT_AVAILABLE}`,
      };
    case "invalid":
      return {
        tone: "error",
        title: "Check the form",
        body: "Choose one of your Intakes and how soon you need help, then try again.",
      };
    case "not-found":
      return {
        tone: "error",
        title: "Intake not found",
        body: "That Intake was not found in your workspace.",
      };
    case "intake-not-ready":
      return {
        tone: "warning",
        title: "This Intake cannot be used",
        body: "Only a submitted Intake that is still open can be used to select an attorney.",
      };
    case "not-available":
      return {
        tone: "warning",
        title: "This attorney cannot be selected right now",
        body: "This attorney is not currently available for what you chose. Nothing was recorded. Return to the directory and choose again.",
      };
    case "rate-limited":
      return {
        tone: "warning",
        title: "Limit reached",
        body: "This Intake already has the maximum number of selections.",
      };
    case "outcome-unknown":
      return {
        tone: "warning",
        title: "We could not confirm your selection",
        body: "Your selection may or may not have been recorded. Check your Intake before trying again.",
      };
    case "sign-in-required":
      return {
        tone: "error",
        title: "Sign in to continue",
        body: "Sign in to your client account to select an attorney.",
      };
    case "denied":
      return {
        tone: "error",
        title: "Not available for this account",
        body: "Selecting an attorney is available to signed-in client accounts.",
      };
    case "unavailable":
      return {
        tone: "error",
        title: "Something went wrong",
        body: "Your selection could not be recorded right now. Please try again later.",
      };
  }
}
