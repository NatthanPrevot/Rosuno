// Consultation communication and notification center labels (MVP-001 S10).
//
// Fixed, plain wording for the participants' Messages and shared documents in
// a Consultation and for the notification center. Nothing here recommends,
// ranks or matches anyone (MBS section 10; Packet rule 11), claims a live or
// approved regulatory status (MBS section 17), writes legal text or describes
// either participant. The server decides whether Messages can still be sent,
// who may open a document, and every delivery state; these labels only show
// what it reports (instants in UTC). No email provider is ever named, no
// address is shown and no file name is kept.

import type {
  CommunicationActionState,
  CommunicationOutcome,
  MessagingStatus,
  ParticipantRole,
} from "../application/consultation-communication.ts";
import type { AcknowledgeActionState } from "../application/notification-center.ts";
import type {
  EmailState,
  NotificationType,
} from "../application/notifications.ts";
import type { ArtifactType } from "../application/protected-resources.ts";
import type { Tone } from "./design-system.tsx";

export { utcText } from "./request-labels.ts";

type Message = {
  readonly tone: Tone;
  readonly title: string;
  readonly body: string;
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const MESSAGES_HEADING = "Messages";
export const MESSAGES_NOTE =
  "Messages here are part of this consultation only. Once sent, a message cannot be changed.";
export const NO_MESSAGES = "No messages yet.";
// Shown when the database answers that older Messages exist beyond the
// newest it returns.
export const OLDER_MESSAGES_NOTE = "Older messages are not shown.";
export const MESSAGE_FIELD_LABEL = "Your message";
export const MESSAGE_FIELD_HINT = "Up to 20,000 characters.";
export const SEND_LABEL = "Send message";

export function senderLabel(role: ParticipantRole, mine: boolean): string {
  if (mine) {
    return "You";
  }
  return role === "attorney" ? "The attorney" : "The client";
}

export function messagingNote(
  status: MessagingStatus,
  closesAt: string | null,
  utc: (timestamp: string) => string,
): string | null {
  if (status === "open") {
    return closesAt === null
      ? null
      : `Messages can be sent until ${utc(closesAt)}.`;
  }
  if (status === "closed") {
    return "This conversation is closed. You can still read it.";
  }
  return "Messages cannot be sent after this consultation for now. You can still read the conversation.";
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const DOCUMENTS_HEADING = "Documents";
export const DOCUMENTS_NOTE =
  "A document you add here is shared only with the other participant of this consultation. Sharing is per version: each version you add is shared on its own, and stopping sharing of one version leaves the other versions as they are.";
export const NO_DOCUMENTS = "No documents yet.";
export const OLDER_DOCUMENTS_NOTE = "Older documents are not shown.";
export const DOCUMENT_FIELD_LABEL = "Add a document";
export const DOCUMENT_FIELD_HINT = "A PDF, PNG, or JPEG of at most 1 MB.";
export const UPLOAD_LABEL = "Share document";
export const OPEN_LABEL = "Get a download link";
export const DOWNLOAD_LINK_LABEL = "Download now";
export const REVOKE_LABEL = "Stop sharing this version";

// Versions (PS-A5): a replacement adds a new version; earlier ones stay.
export const VERSION_COLUMN = "Version";
export const REPLACE_FIELD_LABEL = "Replace with a new version";
export const REPLACE_FIELD_HINT =
  "The new version will be shared with the other participant. The earlier version stays as it is, available to whoever could open it. A PDF, PNG, or JPEG of at most 1 MB.";
export const REPLACE_LABEL = "Upload new version";
export const HISTORY_LINK_LABEL = "Version history";
export const HISTORY_HEADING = "Version history";
export const HISTORY_NOTE =
  "Every version stays as it was added. Each version is shared on its own: stopping sharing of one version leaves the others as they are.";
export const HISTORY_UNAVAILABLE = "This version history is not available.";
export const HISTORY_CLOSE_LABEL = "Close version history";
// Shown when the database answers that older versions exist beyond the
// newest it returns.
export const OLDER_VERSIONS_NOTE = "Older versions are not shown.";
export const CURRENT_VERSION_LABEL = "Current version";
export const EARLIER_VERSION_LABEL = "Earlier version";

export const DOCUMENT_TYPE_LABELS: Readonly<Record<ArtifactType, string>> =
  Object.freeze({
    "application/pdf": "PDF document",
    "image/png": "PNG image",
    "image/jpeg": "JPEG image",
  });

export function byteSizeText(bytes: number): string {
  if (bytes < 1000) {
    return `${bytes} bytes`;
  }
  return `${Math.round(bytes / 100) / 10} KB`;
}

export function uploaderLabel(role: ParticipantRole, mine: boolean): string {
  return mine ? "You" : role === "attorney" ? "The attorney" : "The client";
}

export function sharingLabel(
  sharing: "active" | "revoked",
  mine: boolean,
): string {
  if (sharing === "active") {
    return "Shared";
  }
  return mine ? "Sharing stopped" : "No longer shared with you";
}

// The sharing state of a document's current version in the list, saying when
// an earlier version is still shared (sharing is per version).
export function currentSharingLabel(
  sharing: "active" | "revoked",
  mine: boolean,
  earlierShared: boolean,
): string {
  const label = sharingLabel(sharing, mine);
  if (!earlierShared) {
    return label;
  }
  return mine
    ? `${label}. An earlier version is still shared with the other participant.`
    : `${label}. An earlier version is still shared with you.`;
}

// The sharing state of one version in a history (null: never shared).
export function versionSharingLabel(
  sharing: "active" | "revoked" | null,
  mine: boolean,
): string {
  return sharing === null ? "Not shared" : sharingLabel(sharing, mine);
}

// ---------------------------------------------------------------------------
// Action outcomes
// ---------------------------------------------------------------------------

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
  unconfirmed: {
    tone: "error",
    title: "Could not be confirmed",
    body: "This could not be confirmed. Reload the page to see whether it was completed.",
  },
  step_up: {
    tone: "warning",
    title: "Confirm your sign-in",
    body: "Nothing was sent. This needs a sign-in confirmed with a code from your authenticator app. Reload this page to confirm it, then try again.",
  },
} satisfies Record<string, Message>);

export const COMMUNICATION_OUTCOME_MESSAGES: Readonly<
  Record<CommunicationOutcome, Message>
> = Object.freeze({
  message_sent: {
    tone: "success",
    title: "Message sent",
    body: "Your message was sent.",
  },
  document_shared: {
    tone: "success",
    title: "Document shared",
    body: "Your document was shared with the other participant.",
  },
  document_replaced: {
    tone: "success",
    title: "New version shared",
    body: "The new version was shared with the other participant. The earlier version stays as it was.",
  },
  not_current: {
    tone: "warning",
    title: "Not the current version",
    body: "Nothing was added: a newer version of this document already exists. Replace the current version instead.",
  },
  already_superseded: {
    tone: "warning",
    title: "Already replaced",
    body: "Nothing was added: this version was replaced by another upload at the same time. Reload the page to see the current version.",
  },
  sharing_revoked: {
    tone: "success",
    title: "Sharing stopped",
    body: "The other participant can no longer open this version. Other versions of the document are not affected.",
  },
  already_revoked: {
    tone: "information",
    title: "Already stopped",
    body: "This version is no longer shared.",
  },
  closed: {
    tone: "warning",
    title: "Conversation closed",
    body: "Nothing was sent: this consultation's conversation is closed.",
  },
  window_unavailable: {
    tone: "warning",
    title: "Not available after the consultation",
    body: "Nothing was sent: messages and documents cannot be added after this consultation for now.",
  },
  not_found: {
    tone: "warning",
    title: "Not available",
    body: "This is not available.",
  },
  not_available: {
    tone: "warning",
    title: "Not available yet",
    body: "This document is not available.",
  },
  held: {
    tone: "warning",
    title: "Not available",
    body: "This document cannot be opened at the moment.",
  },
  upload_failed: {
    tone: "error",
    title: "Not added",
    body: "The document could not be stored. Nothing was shared. Please try again.",
  },
});

export function communicationMessage(
  state: CommunicationActionState,
): Message | null {
  switch (state.status) {
    case "idle":
      return null;
    case "download":
      return {
        tone: "success",
        title: "Ready to download",
        body: `The download link below works for ${state.expiresInSeconds} seconds.`,
      };
    case "outcome":
      return COMMUNICATION_OUTCOME_MESSAGES[state.outcome];
    case "invalid":
      return state.field === "body"
        ? {
            tone: "warning",
            title: "Check your message",
            body: "Write a message of up to 20,000 characters.",
          }
        : {
            tone: "warning",
            title:
              state.field === "replacement"
                ? "Check the new version"
                : "Check the document",
            body: "Choose a PDF, PNG, or JPEG of at most 1 MB.",
          };
    case "unconfirmed":
      return SHARED_MESSAGES.unconfirmed;
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

// ---------------------------------------------------------------------------
// The notification center
// ---------------------------------------------------------------------------

export const CENTER_TITLE = "Notifications";
export const CENTER_INTRO =
  "Updates about your requests and consultations. Emails about them contain no details of your matter.";
export const NO_NOTIFICATIONS = "No notifications yet.";
export const ACKNOWLEDGE_LABEL = "Acknowledge";
export const OPEN_NOTIFICATION_LABEL = "Open";

export const NOTIFICATION_LABELS: Readonly<Record<NotificationType, string>> =
  Object.freeze({
    request_awaiting_decision:
      "A consultation request is waiting for your decision",
    request_accepted: "Your consultation request was accepted",
    request_declined: "Your consultation request was declined",
    request_expired: "Your consultation request expired",
    consultation_ready: "Your consultation is ready",
    message_received: "New message in your consultation",
    document_shared: "A document was shared with you",
    // MVP-001 S11 (correction D14).
    consultation_cancelled: "A consultation was cancelled",
    consultation_outcome_recorded:
      "An outcome was recorded for your consultation",
    review_available: "You can review your ended consultation",
    complaint_received: "We received the problem you reported",
  });

export const EMAIL_STATE_LABELS: Readonly<Record<EmailState, string>> =
  Object.freeze({
    pending: "Email waiting to be sent",
    sent: "Email sent",
    delivered: "Email delivered",
    failed: "Email could not be delivered",
    retrying: "Email being retried",
    permanently_failed: "Email could not be delivered",
  });

export function acknowledgeMessage(
  state: AcknowledgeActionState,
): Message | null {
  switch (state.status) {
    case "idle":
      return null;
    case "outcome":
      switch (state.outcome) {
        case "acknowledged":
          return {
            tone: "success",
            title: "Acknowledged",
            body: "Thank you, this notification is acknowledged.",
          };
        case "already_acknowledged":
          return {
            tone: "information",
            title: "Already acknowledged",
            body: "This notification was already acknowledged.",
          };
        case "not_required":
          return {
            tone: "information",
            title: "No acknowledgement needed",
            body: "This notification does not need an acknowledgement.",
          };
        default:
          return {
            tone: "warning",
            title: "Not available",
            body: "This notification is not available.",
          };
      }
    case "unconfirmed":
      return SHARED_MESSAGES.unconfirmed;
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
