// Privacy and security action labels (MVP-001 S11; PS-A6 sections 2 and 3).
//
// Fixed, plain wording for break-glass access and data requests. Nothing here
// states a legal right, an entitlement, a timeline, a retention period or
// what a decision will lead to (Packet rule 11: no unapproved legal or
// regulatory text): a data request is described only as a request that Rosuno
// staff review and record a decision on, and a decision is described only by
// its code. The server decides every state, outcome and time; these labels
// only show what it reports (instants in UTC).

import type {
  GrantActionOutcome,
  GrantState,
  ParticipantRole,
  SharingState,
} from "../application/break-glass.ts";
import type {
  AccountState,
  ClientActionOutcome,
  OutcomeCode,
  RequestState,
  RequestType,
  StaffActionOutcome,
} from "../application/data-requests.ts";
import type { Message } from "./completion-labels.ts";
import type { Tone } from "./design-system.tsx";

type Label = { readonly label: string; readonly tone: Tone };

const NOT_FOUND = {
  tone: "warning",
  title: "Not found",
  body: "This could not be found. Nothing was changed.",
} as const;

// ---------------------------------------------------------------------------
// Break-glass access
// ---------------------------------------------------------------------------

export const GRANT_STATE_LABELS: Readonly<Record<GrantState, Label>> =
  Object.freeze({
    requested: { label: "Requested", tone: "information" },
    active: { label: "Active", tone: "warning" },
    expired: { label: "Expired", tone: "neutral" },
    revoked: { label: "Revoked", tone: "neutral" },
  });

export const PARTICIPANT_ROLE_LABELS: Readonly<
  Record<ParticipantRole, string>
> = Object.freeze({
  client: "Client",
  attorney: "Attorney",
});

export const SHARING_LABELS: Readonly<Record<SharingState, string>> =
  Object.freeze({
    active: "Shared",
    revoked: "Sharing revoked",
    none: "Not shared",
  });

export const BREAK_GLASS_NOTE =
  "Break-glass access is read-only, limited to one consultation and to the time an approver sets, and every request, approval, revocation and access is recorded. Request it only with a reason that justifies it.";

export const BREAK_GLASS_ACCESS_NOTE =
  "Read-only break-glass access. This view is recorded each time it is opened. Document contents are not available here.";

// The refusal of the break-glass pages to a caller without an active Staff
// Profile (the surface needs that profile, not a capability).
export const BREAK_GLASS_STAFF_REQUIRED =
  "Break-glass access is available only to staff members with an active staff profile. This account does not have one.";

export const BREAK_GLASS_NOT_ACTIVE =
  "This break-glass access is not available: it is not one of your grants, it has not been approved, or it has expired or been revoked.";

export const GRANT_MESSAGES: Readonly<Record<GrantActionOutcome, Message>> =
  Object.freeze({
    access_requested: {
      tone: "success",
      title: "Access requested",
      body: "The request is recorded. Another staff member who may approve break-glass access decides on it.",
    },
    already_requested: {
      tone: "neutral",
      title: "Already requested",
      body: "You already have a request or an active access for this consultation. Nothing was changed.",
    },
    access_approved: {
      tone: "success",
      title: "Access approved",
      body: "The access is active for the duration you chose. It is listed under Active.",
    },
    own_request: {
      tone: "warning",
      title: "Not possible",
      body: "A request cannot be approved by the staff member who made it. Nothing was changed.",
    },
    request_refused: {
      tone: "success",
      title: "Request refused",
      body: "The request is refused.",
    },
    access_ended: {
      tone: "success",
      title: "Access ended",
      body: "The access is revoked and ends now.",
    },
    already_active: {
      tone: "neutral",
      title: "Already active",
      body: "This access is already approved. Nothing was changed.",
    },
    already_expired: {
      tone: "neutral",
      title: "Already expired",
      body: "This access has already expired. Nothing was changed.",
    },
    already_revoked: {
      tone: "neutral",
      title: "Already revoked",
      body: "This request or access was already revoked. Nothing was changed.",
    },
    not_found: NOT_FOUND,
  });

// ---------------------------------------------------------------------------
// Data requests
// ---------------------------------------------------------------------------

export const REQUEST_TYPE_LABELS: Readonly<Record<RequestType, string>> =
  Object.freeze({
    access: "Access to my data",
    correction: "Correction of my data",
    deletion: "Deletion of my data",
    export: "Export of my data",
    restriction: "Restriction of the use of my data",
  });

export const STAFF_REQUEST_TYPE_LABELS: Readonly<Record<RequestType, string>> =
  Object.freeze({
    access: "Access",
    correction: "Correction",
    deletion: "Deletion",
    export: "Export",
    restriction: "Restriction",
  });

export const REQUEST_STATE_LABELS: Readonly<Record<RequestState, Label>> =
  Object.freeze({
    submitted: { label: "Submitted", tone: "information" },
    in_review: { label: "In review", tone: "warning" },
    decided: { label: "Decided", tone: "success" },
    withdrawn: { label: "Withdrawn", tone: "neutral" },
  });

export const OUTCOME_LABELS: Readonly<Record<OutcomeCode, string>> =
  Object.freeze({
    allowed: "Allowed",
    restricted: "Restricted",
    deferred: "Deferred",
    denied: "Denied",
  });

// The client's list names the decision field as a record only (recording a
// decision changes no data; PS-A6 section 3 rule 4).
export const RECORDED_DECISION_LABEL = "Recorded decision";

export const ACCOUNT_STATE_LABELS: Readonly<Record<AccountState, string>> =
  Object.freeze({
    pending_verification: "Pending verification",
    active: "Active",
    suspended: "Suspended",
    closed: "Closed",
  });

export const DATA_REQUEST_NOTE =
  "You can ask Rosuno about the data your account holds. Rosuno staff review each request and record a decision, which is shown here.";

export const DATA_REQUEST_STAFF_NOTE =
  "Recording a decision is a record only: it does not delete, export, correct or restrict anything. A deletion request cannot be recorded as allowed while a Legal Hold applies.";

export const CLIENT_REQUEST_MESSAGES: Readonly<
  Record<ClientActionOutcome, Message>
> = Object.freeze({
  request_submitted: {
    tone: "success",
    title: "Request submitted",
    body: "Your request is recorded. Rosuno staff review it.",
  },
  already_open: {
    tone: "neutral",
    title: "Already submitted",
    body: "You already have an open request of this kind. Nothing was changed.",
  },
  request_withdrawn: {
    tone: "success",
    title: "Request withdrawn",
    body: "Your request is withdrawn.",
  },
  already_decided: {
    tone: "neutral",
    title: "Already decided",
    body: "This request already has a decision, so it can no longer be withdrawn. Nothing was changed.",
  },
  already_withdrawn: {
    tone: "neutral",
    title: "Already withdrawn",
    body: "This request was already withdrawn. Nothing was changed.",
  },
  not_found: NOT_FOUND,
});

export const STAFF_REQUEST_MESSAGES: Readonly<
  Record<StaffActionOutcome, Message>
> = Object.freeze({
  applied: {
    tone: "success",
    title: "Saved",
    body: "The request is updated.",
  },
  not_found: NOT_FOUND,
  invalid_transition: {
    tone: "neutral",
    title: "Not possible now",
    body: "The request cannot change this way in its current state. Nothing was changed.",
  },
  legal_hold: {
    tone: "warning",
    title: "A Legal Hold applies",
    body: "A deletion request cannot be recorded as allowed while a Legal Hold applies. Nothing was changed.",
  },
});
