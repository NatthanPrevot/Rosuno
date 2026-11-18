// Consultation workspace labels (MVP-001 S9).
//
// Fixed, plain wording for the client's and the attorney's Consultation
// workspaces, the waiting room and the media room. Nothing here recommends,
// ranks or matches anyone (MBS section 10; Packet rule 11), claims a live or
// approved regulatory status (MBS section 17), writes legal text (MB section
// 47: counsel review) or describes either participant. The server decides
// every state, window and time; these labels only show what it reports
// (instants in UTC). Recording is not offered (MBS section 14). The provider
// is never named: the room is "the consultation room".

import type {
  CommandActionState,
  CommandOutcome,
  DisplayState,
  JoinActionState,
  JoinOutcome,
} from "../application/consultations.ts";
import type { MediaRoomState } from "../application/media-provider.ts";
import type { Tone } from "./design-system.tsx";

export { durationText, modalityText, utcText } from "./request-labels.ts";

type Message = {
  readonly tone: Tone;
  readonly title: string;
  readonly body: string;
};

export const CLIENT_STATE_LABELS: Readonly<
  Record<DisplayState, { readonly label: string; readonly tone: Tone }>
> = Object.freeze({
  created: { label: "Being set up", tone: "neutral" },
  scheduled: { label: "Scheduled", tone: "information" },
  ready: { label: "Waiting for the attorney to start", tone: "information" },
  live: { label: "In progress", tone: "success" },
  completed: { label: "Ended", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  no_show: { label: "Did not take place", tone: "neutral" },
  technical_failure: { label: "Ended by a technical problem", tone: "warning" },
});

export const ATTORNEY_STATE_LABELS: Readonly<
  Record<DisplayState, { readonly label: string; readonly tone: Tone }>
> = Object.freeze({
  created: { label: "Being set up", tone: "neutral" },
  scheduled: { label: "Scheduled", tone: "information" },
  ready: { label: "Ready to start", tone: "information" },
  live: { label: "In progress", tone: "success" },
  completed: { label: "Ended", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  no_show: { label: "Did not take place", tone: "neutral" },
  technical_failure: { label: "Ended by a technical problem", tone: "warning" },
});

export const MEDIA_STATE_LABELS: Readonly<Record<MediaRoomState, string>> =
  Object.freeze({
    pending: "Being prepared",
    open: "Open",
    closing: "Closing",
    closed: "Closed",
  });

export const PATH_LABELS: Readonly<Record<"instant" | "scheduled", string>> =
  Object.freeze({
    instant: "As soon as possible",
    scheduled: "At a scheduled time",
  });

export const COMPLETION_LABELS: Readonly<Record<string, string>> =
  Object.freeze({
    normal: "Completed by the attorney",
  });

export const WORKSPACE_NOTE =
  "Times are shown in UTC and come from the server. The consultation room opens at the time shown and is never recorded.";
export const CLIENT_WAITING_NOTE =
  "You are in the waiting room. The consultation room opens once the attorney starts the consultation. Reload this page then to join.";
export const ATTORNEY_READY_NOTE =
  "Start the consultation when you are ready; the consultation room then opens for you and the client.";
export const NOT_OPEN_NOTE = "The consultation room is not open yet.";
export const WINDOW_PASSED_NOTE =
  "The time for this consultation has passed. The room is no longer open.";
export const ENDED_NOTE = "This consultation has ended.";
export const NO_CONSULTATIONS = "You have no upcoming or current consultation.";
export const LIST_INTRO =
  "Your scheduled, ready and current consultations, as the server reports them.";
export const EVIDENCE_NOTE =
  "Attendance is recorded from the consultation room and does not change the consultation by itself.";

export const JOIN_LABEL = "Join the consultation room";
export const REJOIN_LABEL = "Rejoin the consultation room";
export const START_LABEL = "Start the consultation";
export const END_LABEL = "End the consultation";
export const FRAME_TITLE = "Consultation room";

// The camera, microphone, autoplay and screen sharing the room needs.
export const FRAME_ALLOW = "camera; microphone; autoplay; display-capture";

const SHARED_MESSAGES = Object.freeze({
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
    body: "This could not be completed right now. Please try again later.",
  },
  step_up: {
    tone: "warning",
    title: "Confirm your sign-in",
    body: "Nothing was sent. This needs a sign-in confirmed with a code from your authenticator app. Reload this page to confirm it, then try again.",
  },
} satisfies Record<string, Message>);

export const JOIN_OUTCOME_MESSAGES: Readonly<Record<JoinOutcome, Message>> =
  Object.freeze({
    waiting: {
      tone: "information",
      title: "Waiting for the start",
      body: "The consultation room opens once the attorney starts the consultation. Please try again then.",
    },
    preparing: {
      tone: "information",
      title: "The room is being prepared",
      body: "The consultation room is being prepared. Please try again in a moment.",
    },
    not_open_yet: {
      tone: "information",
      title: "Not open yet",
      body: "The consultation room is not open yet. Please come back at the time shown.",
    },
    ended: {
      tone: "neutral",
      title: "The room is closed",
      body: "The consultation room is closed for this consultation.",
    },
    configuration_unavailable: {
      tone: "error",
      title: "Not available right now",
      body: "The consultation room is not available right now. Nothing was changed.",
    },
    media_unavailable: {
      tone: "error",
      title: "The room service is unavailable",
      body: "The consultation room service is not available right now. Please try again later.",
    },
    not_found: {
      tone: "warning",
      title: "Consultation not found",
      body: "This consultation could not be found.",
    },
  });

export function joinMessage(state: JoinActionState): Message | null {
  switch (state.status) {
    case "idle":
    case "granted":
      return null;
    case "outcome":
      return JOIN_OUTCOME_MESSAGES[state.outcome];
    case "unconfirmed":
      return {
        tone: "error",
        title: "Could not be confirmed",
        body: "The room could not be opened. Reload the page and try again.",
      };
    case "sign-in-required":
      return SHARED_MESSAGES.sign_in;
    case "denied":
      return SHARED_MESSAGES.denied;
    case "unavailable":
      return SHARED_MESSAGES.unavailable;
    case "step-up-required":
      return SHARED_MESSAGES.step_up;
    default:
      return null;
  }
}

export const COMMAND_OUTCOME_MESSAGES: Readonly<
  Record<CommandOutcome, Message>
> = Object.freeze({
  consultation_started: {
    tone: "success",
    title: "Consultation started",
    body: "The consultation is in progress.",
  },
  consultation_completed: {
    tone: "success",
    title: "Consultation ended",
    body: "The consultation has ended and the room is closing.",
  },
  not_found: {
    tone: "warning",
    title: "Consultation not found",
    body: "This consultation could not be found.",
  },
  ended: {
    tone: "neutral",
    title: "Already ended",
    body: "This consultation has already ended. Nothing was changed.",
  },
  already_started: {
    tone: "neutral",
    title: "Already started",
    body: "This consultation is already in progress. Nothing was changed.",
  },
  not_ready: {
    tone: "information",
    title: "Not ready yet",
    body: "This consultation cannot be started yet. Nothing was changed.",
  },
  not_started: {
    tone: "information",
    title: "Not started",
    body: "This consultation has not started, so it cannot be ended. Nothing was changed.",
  },
  configuration_unavailable: {
    tone: "error",
    title: "Not available right now",
    body: "This cannot be done right now. Nothing was changed.",
  },
  not_open_yet: {
    tone: "information",
    title: "Not open yet",
    body: "The consultation cannot be started before the time shown. Nothing was changed.",
  },
  window_passed: {
    tone: "warning",
    title: "The time has passed",
    body: "The time for this consultation has passed, so it cannot be started. Nothing was changed.",
  },
  attorney_in_consultation: {
    tone: "warning",
    title: "Another consultation is in progress",
    body: "End your current consultation before starting this one. Nothing was changed.",
  },
  payment_not_ready: {
    tone: "warning",
    title: "Payment step not complete",
    body: "This consultation cannot be started until its payment step is complete. Nothing was changed.",
  },
  not_eligible: {
    tone: "warning",
    title: "Cannot be started",
    body: "This consultation cannot be started at this time. Nothing was changed. Your professional records are shown in professional setup.",
  },
  eligibility_unavailable: {
    tone: "error",
    title: "Could not be checked",
    body: "The consultation could not be checked right now. Nothing was changed. Please try again later.",
  },
  conflict: {
    tone: "error",
    title: "Could not be completed",
    body: "This could not be completed. Nothing was changed. Reload the page and try again.",
  },
});

export function commandMessage(state: CommandActionState): Message | null {
  switch (state.status) {
    case "idle":
      return null;
    case "outcome":
      return COMMAND_OUTCOME_MESSAGES[state.outcome];
    case "invalid":
      return {
        tone: "error",
        title: "Something was wrong with the form",
        body: "Reload the page and try again.",
      };
    case "unconfirmed":
      return {
        tone: "error",
        title: "Could not be confirmed",
        body: "This may or may not have been recorded. Reload the page to see the consultation before trying again.",
      };
    case "sign-in-required":
      return SHARED_MESSAGES.sign_in;
    case "denied":
      return SHARED_MESSAGES.denied;
    case "unavailable":
      return SHARED_MESSAGES.unavailable;
    case "step-up-required":
      return SHARED_MESSAGES.step_up;
    default:
      return null;
  }
}
