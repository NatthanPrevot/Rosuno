// Client and attorney workspace labels (MVP-001 S11 pass 2B; MBS sections
// 18.2 and 18.3).
//
// Fixed, plain wording for the workspace navigation, the dashboards, the
// payment history, the Message inboxes, the account and data pages, the
// attorney's past consultations, week view, documents and compliance page.
// Nothing here states a policy value, a threshold, a legal decision, an
// entitlement or a regulatory status, names a provider or recommends anyone;
// the server decides every state, count and date, and these labels only show
// what it reports (instants in UTC). No privacy, terms or other legal text is
// approved yet (Packet rule 11): the data page repeats only the public
// privacy page's own words that such information is not yet available.

import type {
  AuthorisationView,
  ClaimVerification,
  EligibilityView,
} from "../application/attorney-professional.ts";
import type {
  DataCategory,
  MessagingStatus,
  RecordKind,
} from "../application/participant-workspaces.ts";
import type {
  AccountState,
  ProfileState,
} from "../application/professional-records.ts";
import type { Tone } from "./design-system.tsx";

export {
  byteSizeText,
  DOCUMENT_TYPE_LABELS,
  sharingLabel,
  uploaderLabel,
} from "./communication-labels.ts";
export { moneyText, utcText } from "./request-labels.ts";

type Label = { readonly label: string; readonly tone: Tone };

export type NavigationLink = {
  readonly href: string;
  readonly label: string;
};

// ---------------------------------------------------------------------------
// Workspace navigation: one fixed set per workspace, first-party links only
// (each page decides its own access).
// ---------------------------------------------------------------------------

export const CLIENT_NAVIGATION: readonly NavigationLink[] = Object.freeze([
  { href: "/client", label: "Workspace home" },
  { href: "/find-an-attorney", label: "Find an attorney" },
  { href: "/client/consultations", label: "Consultations" },
  { href: "/client/messages", label: "Messages" },
  { href: "/client/payments", label: "Payments" },
  { href: "/client/reviews", label: "Reviews" },
  { href: "/client/notifications", label: "Notifications" },
  { href: "/client/settings", label: "Profile and settings" },
  { href: "/client/privacy", label: "Privacy and data" },
  { href: "/client/complaints", label: "Report a problem" },
  { href: "/help", label: "Help" },
]);

export const ATTORNEY_NAVIGATION: readonly NavigationLink[] = Object.freeze([
  { href: "/attorney/dashboard", label: "Dashboard" },
  { href: "/attorney/requests", label: "Requests" },
  { href: "/attorney/consultations", label: "Consultations" },
  { href: "/attorney/consultations/history", label: "Past consultations" },
  { href: "/attorney/schedule", label: "Schedule" },
  { href: "/attorney/schedule/week", label: "Week view" },
  { href: "/attorney/messages", label: "Messages" },
  { href: "/attorney/documents", label: "Documents" },
  { href: "/attorney/earnings", label: "Earnings" },
  { href: "/attorney/offers", label: "Offers" },
  { href: "/attorney/compliance", label: "Compliance" },
  { href: "/attorney/professional", label: "Professional profile" },
  { href: "/account/security", label: "Account security" },
  { href: "/attorney/reviews", label: "Reviews" },
  { href: "/attorney/notifications", label: "Notifications" },
  { href: "/attorney/complaints", label: "Report a problem" },
  { href: "/help", label: "Help" },
]);

export const CLIENT_NAVIGATION_LABEL = "Client workspace";
export const ATTORNEY_NAVIGATION_LABEL = "Attorney workspace";

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export const TIMES_NOTE = "Times are shown in UTC and come from the server.";

export const MESSAGING_STATUS_LABELS: Readonly<Record<MessagingStatus, Label>> =
  Object.freeze({
    open: { label: "Messaging open", tone: "success" },
    closed: { label: "Read-only", tone: "neutral" },
    window_unavailable: { label: "Messaging not available", tone: "warning" },
  });

export const INBOX_INTRO =
  "Each consultation has its own message thread. Open a consultation to read its messages and, while messaging is open, to write.";
export const NO_THREADS = "You have no consultation threads yet.";

export function lastMessageText(
  at: string | null,
  mine: boolean | null,
  utc: (timestamp: string) => string,
): string {
  if (at === null) {
    return "No messages yet.";
  }
  return `Last message ${utc(at)}, ${mine ? "from you" : "to you"}.`;
}

export function messageCountText(count: number): string {
  return count === 1 ? "1 message" : `${count} messages`;
}

// ---------------------------------------------------------------------------
// Client surfaces
// ---------------------------------------------------------------------------

export const CLIENT_HOME_HEADING = "Your consultations now";
export const CLIENT_HOME_NONE =
  "You have no consultation in progress or coming up.";
export const FIND_ATTORNEY_LABEL = "Find an attorney";

export const PAYMENTS_INTRO =
  "Every payment attempt of your consultation requests, newest first, with the state Rosuno has recorded. Open one to see its receipt and any refund as the ledger recorded it.";
export const NO_PAYMENTS = "You have no payments yet.";

export function refundText(
  state: string,
  refundedMinor: number,
  money: string,
): string | null {
  if (refundedMinor <= 0) {
    return state === "refund_pending" ? "Refund in progress." : null;
  }
  return `Refunded so far: ${money}.`;
}

export const SETTINGS_INTRO =
  "Your account as Rosuno has recorded it. Your display name cannot be changed here yet.";
export const NO_DISPLAY_NAME = "Not provided";
export const ACCOUNT_STATE_LABELS: Readonly<Record<AccountState, Label>> =
  Object.freeze({
    pending_verification: {
      label: "Awaiting email confirmation",
      tone: "information",
    },
    active: { label: "Active", tone: "success" },
    suspended: { label: "Suspended", tone: "warning" },
    closed: { label: "Closed", tone: "neutral" },
  });
export const SIGN_IN_SECURITY_NOTE =
  'You sign in with your email address and password. To set a new password, sign out and choose "Forgot password?" on the sign-in page; a link is sent to your email address.';

export const DATA_INTRO =
  "The kinds of records your account holds, as counts. Nothing here shows their content; each is shown on its own page of your workspace.";
export const DATA_CATEGORY_LABELS: Readonly<Record<DataCategory, string>> =
  Object.freeze({
    intakes: "Intakes",
    requests: "Consultation requests",
    consultations: "Consultations",
    documents: "Documents you uploaded",
    messages: "Messages you sent",
    payments: "Payment attempts",
    complaints: "Reported problems",
  });
// The public privacy page's own words (no privacy text is approved yet).
export const PRIVACY_NOT_AVAILABLE =
  "Privacy information is not yet available.";
export const DATA_REQUESTS_NOT_AVAILABLE =
  "Requests about your data cannot be made here yet.";

// ---------------------------------------------------------------------------
// Attorney surfaces
// ---------------------------------------------------------------------------

export const DASHBOARD_INTRO =
  "A summary of your workspace at the moment this page was loaded. Each section links to the page where you act.";
export const SECTION_UNAVAILABLE = "This section could not be shown right now.";

export function pendingText(instant: number, scheduled: number): string {
  const total = instant + scheduled;
  if (total === 0) {
    return "No requests are awaiting your decision.";
  }
  return `${total} awaiting your decision (${instant} as soon as possible, ${scheduled} at a scheduled time).`;
}

export function instantText(
  on: boolean | null,
  configured: boolean | null,
): string {
  if (on === null) {
    return "Instant mode status could not be read.";
  }
  if (configured === false && !on) {
    return "Instant mode has not been configured for the platform yet.";
  }
  return on ? "Instant mode is on." : "Instant mode is off.";
}

export function availabilityText(windows: number, days: number): string {
  return windows === 0
    ? `No availability in the next ${days} days.`
    : `${windows} availability window(s) in the next ${days} days.`;
}

export const EARNINGS_NOTE =
  "Ledger-derived amounts attributed to you, net of reversals, per currency.";
export const NO_EARNINGS = "No earnings are recorded yet.";

export function unacknowledgedText(count: number): string {
  return count === 0
    ? "No notification is waiting for your acknowledgement."
    : `${count} notification(s) waiting for your acknowledgement.`;
}

export function openComplaintsText(count: number): string {
  return count === 0
    ? "No reported problem is open."
    : `${count} reported problem(s) not yet resolved.`;
}

export const COMPLIANCE_ALERT_NOTE =
  "Dates come from your own records. No reminder period is applied: a date is shown as passed or as the next date ahead.";

export function lapsedText(count: number): string {
  return `${count} licence or insurance record(s) past their recorded end date.`;
}

export function evidenceAgedText(count: number): string {
  return `${count} record(s) whose latest verification evidence has reached the age the current eligibility policy states.`;
}

export function openFindingsText(count: number): string {
  return `${count} discipline finding(s) recorded without a resolved date.`;
}

export function nextDateText(date: string | null): string {
  return date === null
    ? "No end or evidence date ahead is recorded."
    : `Next recorded end or evidence date: ${date}.`;
}

export const HISTORY_INTRO =
  "Your ended consultations, the most recent first (at most 200). Open one to see its record, messages and documents.";
export const NO_HISTORY = "You have no ended consultations yet.";

export const WEEK_INTRO =
  "A read-only view of seven UTC days of your calendar: availability, blackouts, holds for pending requests and bookings. Change your schedule on the schedule page.";
export const NO_ENTRIES = "Nothing scheduled.";

export const DOCUMENTS_INTRO =
  "The current versions of the documents you uploaded or that were shared with you, across your consultations, newest first. Open the consultation to download or manage one.";
export const NO_ATTORNEY_DOCUMENTS = "No documents yet.";
export const MORE_DOCUMENTS_NOTE =
  "Only the newest 200 documents are listed here; every document is on its consultation's page.";

export const COMPLIANCE_INTRO =
  "Your own professional records as Rosuno has recorded them. Nothing here verifies, approves or decides eligibility; change your claims in your professional profile.";
export const RECORD_KIND_LABELS: Readonly<Record<RecordKind, string>> =
  Object.freeze({
    license: "Licence",
    insurance: "Insurance",
    discipline: "Discipline finding",
  });
export const NO_DISCIPLINE = "No discipline finding is recorded.";
export const NOT_RECORDED = "Not recorded";
export const WAITLIST_NOTE =
  "Waitlist: this jurisdiction is not open yet. A licence there gives no marketplace visibility, referrals or consultations until it opens.";

// The same words as the professional profile page.
export const PROFILE_STAGE_LABELS: Readonly<Record<ProfileState, string>> =
  Object.freeze({
    applicant: "Applicant (not yet submitted)",
    under_review: "Under review",
    approved: "Approved (profile stage only)",
    suspended: "Suspended",
    removed: "Removed",
  });

export const VERIFICATION_LABELS: Readonly<Record<ClaimVerification, Label>> =
  Object.freeze({
    awaiting_review: { tone: "neutral", label: "Awaiting review" },
    source_checked: { tone: "success", label: "Source check recorded" },
    needs_attention: { tone: "warning", label: "Needs attention" },
  });

export const ELIGIBILITY_LABELS: Readonly<
  Record<EligibilityView["result"], Label>
> = Object.freeze({
  eligible: { tone: "success", label: "Eligible (recorded determination)" },
  not_eligible: { tone: "error", label: "Not eligible" },
  undetermined: { tone: "warning", label: "Not determined" },
  other: { tone: "neutral", label: "Recorded" },
});

export const AUTHORISATION_LABELS: Readonly<
  Record<AuthorisationView["status"], string>
> = Object.freeze({
  requested: "Requested, awaiting decision",
  withdrawn: "Withdrawn",
  authorised: "Authorised by review staff",
  refused: "Not authorised",
  other: "Recorded",
});
