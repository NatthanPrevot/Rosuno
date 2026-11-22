// Staff operations and administration labels (MVP-001 S11 pass 2).
//
// Fixed, plain wording for the operations dashboard, system health, the
// audit workspace, referral operations, the financial activity summary,
// client administration, attorney lifecycle operations and the compliance
// workspace, and one fixed message for every action outcome. Nothing here
// states a policy value, a threshold, a legal decision or a regulatory
// status, names a provider or recommends anyone; the server decides every
// state, count and outcome, and these labels only show what it reports
// (instants in UTC). Hosted checks are out of scope here (L6 HOLD).

import type {
  AccountState,
  ClientActionOutcome,
  ComplianceSection,
  LifecycleActionOutcome,
  LifecycleIntent,
  ProfileStage,
} from "../application/administration-workspace.ts";
import type {
  EnvironmentClassValue,
  EnvironmentStatus,
  ProviderArea,
  ProviderStatus,
  ReferralCountMetric,
  Sweep,
} from "../application/operations-workspace.ts";
import type { Message } from "./completion-labels.ts";
import type { Tone } from "./design-system.tsx";

export { messageOf, utcText } from "./completion-labels.ts";

type Label = { readonly label: string; readonly tone: Tone };

// ---------------------------------------------------------------------------
// The operations dashboard and system health
// ---------------------------------------------------------------------------

export const OPERATIONS_INTRO =
  "Counts only, from the database, at the moment this page was loaded. Nothing here names a person or shows the content of a matter.";

export const METRIC_TITLES: Readonly<Record<string, string>> = Object.freeze({
  jobs: "Background jobs",
  notifications: "Email notifications needing attention",
  review_exceptions: "Open review items",
  consultations: "Consultations",
  requests: "Requests awaiting a decision",
  payments: "Payments in a transitional state",
  attorney_profiles: "Attorney profiles",
  jurisdictions: "Jurisdictions by lifecycle state",
  scheduler: "Scheduled database sweeps",
});

export const DIMENSION_LABELS: Readonly<Record<string, string>> = Object.freeze(
  {
    pending: "Waiting",
    running: "Running",
    completed: "Completed",
    escalated: "Escalated",
    cancelled: "Cancelled",
    retrying: "Retrying",
    permanently_failed: "Permanently failed",
    ready: "Ready",
    live: "Live",
    stale: "Not ended after their window (need an outcome)",
    created: "Created",
    payment_authorized: "Payment authorized",
    slot_held: "Time held",
    awaiting_attorney: "Awaiting the attorney",
    pending_authorization: "Awaiting authorization",
    release_pending: "Release requested",
    capture_pending: "Capture requested",
    refund_pending: "Refund requested",
    under_review: "Under review",
    unsupported: "Unsupported",
    waitlist: "Waitlist",
    staged: "Staged",
    restricted: "Restricted",
    suspended: "Suspended",
    pg_cron: "Database scheduler installed",
  },
);

export const SWEEP_LABELS: Readonly<Record<Sweep, string>> = Object.freeze({
  rosuno_operational_jobs_sweep: "Background job reclamation and escalation",
  rosuno_intake_expiry_sweep: "Intake expiry",
  rosuno_scheduling_expiry_sweep: "Held time expiry",
  rosuno_request_expiry_sweep: "Request expiry",
  rosuno_consultation_media_sweep: "Consultation readiness and room closing",
});

export const FAMILY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  financial: "Financial",
  compliance: "Compliance",
  operations: "Operations",
});

export const ENVIRONMENT_CLASS_LABELS: Readonly<
  Record<EnvironmentClassValue, string>
> = Object.freeze({
  development: "Development",
  staging: "Staging",
  production: "Production",
  unrecorded: "Not recorded",
});

export const ENVIRONMENT_STATUS_LABELS: Readonly<
  Record<EnvironmentStatus, Label>
> = Object.freeze({
  ok: { label: "Recorded and consistent", tone: "success" },
  environment_unrecorded: { label: "Not recorded", tone: "error" },
  environment_mismatch: {
    label: "Does not match this request",
    tone: "error",
  },
});

export const PROVIDER_AREA_LABELS: Readonly<Record<ProviderArea, string>> =
  Object.freeze({
    payments: "Payments",
    media: "Consultation rooms",
    email: "Email",
    ai: "Intake suggestions",
  });

export const PROVIDER_STATUS_LABELS: Readonly<Record<ProviderStatus, Label>> =
  Object.freeze({
    configured: { label: "Configured", tone: "success" },
    not_configured: { label: "Not configured", tone: "warning" },
  });

export const SYSTEM_HEALTH_NOTE =
  "Configured means only that this deployment's settings for that area are present and have the expected shape. No value is shown, and no provider was contacted.";

export const HOSTED_CHECKS_NOTE =
  "Checks of the hosted services themselves (reachability, deployment health) are not part of this page yet.";

// ---------------------------------------------------------------------------
// The audit workspace
// ---------------------------------------------------------------------------

export const AUDIT_INTRO =
  "The audit record, newest first. It is read-only, and each page you open here is itself recorded.";

export const SECURITY_GROUP_NOTE =
  "Security events are the sign-in protection events and the capability grant changes. No step-up or refused-access event is recorded separately.";

export const AUDIT_FILTERS_INVALID =
  "One of the filters is not in the expected form, so nothing was read. Check the dates, codes and identifiers.";

// ---------------------------------------------------------------------------
// Referral operations
// ---------------------------------------------------------------------------

export const REFERRAL_INTRO =
  "Referrals as recorded, newest first: no intake content, client identity or other attorneys' details.";

export const REFERRAL_COUNT_LABELS: Readonly<
  Record<ReferralCountMetric, string>
> = Object.freeze({
  open: "No outcome recorded",
  ended_without_request: "Outcome recorded without a request",
  request_expired: "Request expired",
  request_declined: "Request declined",
});

export const ALLOCATION_LABELS: Readonly<Record<string, string>> =
  Object.freeze({
    client_selected: "Chosen by the client",
    allocated: "Allocated",
  });

export const STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  created: "Created",
  payment_authorized: "Payment authorized",
  slot_held: "Time held",
  awaiting_attorney: "Awaiting the attorney",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  cancelled: "Cancelled",
  scheduled: "Scheduled",
  ready: "Ready",
  live: "Live",
  completed: "Completed",
  no_show: "No-show",
  technical_failure: "Technical failure",
});

// ---------------------------------------------------------------------------
// The financial activity summary
// ---------------------------------------------------------------------------

export const FINANCE_SUMMARY_INTRO =
  "Totals from the append-only ledger for the chosen period (whole UTC days, the last day included, at most 366 days). Read-only.";

export const ENTRY_TYPE_LABELS: Readonly<Record<string, string>> =
  Object.freeze({
    client_payment: "Client payment",
    attorney_share: "Attorney share",
    platform_fee: "Platform fee",
    client_fee: "Client fee",
    other_required_fee: "Other required fee",
  });

export const PAYMENT_STATE_LABELS: Readonly<Record<string, string>> =
  Object.freeze({
    pending_authorization: "Awaiting authorization",
    authorized: "Authorized",
    failed: "Failed",
    cancelled: "Cancelled",
    release_pending: "Release requested",
    authorization_released: "Authorization released",
    capture_pending: "Capture requested",
    captured: "Captured",
    capture_failed: "Capture failed",
    refund_pending: "Refund requested",
    partially_refunded: "Partially refunded",
    fully_refunded: "Fully refunded",
    charged_back: "Disputed",
  });

export const FINANCE_PERIOD_INVALID =
  "Choose a start and an end date (the end on or after the start, at most 366 days), and optionally one jurisdiction.";

// ---------------------------------------------------------------------------
// Client administration
// ---------------------------------------------------------------------------

export const CLIENTS_INTRO =
  "Client accounts with their counts only. No intake content, message, document or payment detail is shown here.";

export const ACCOUNT_STATE_LABELS: Readonly<Record<AccountState, Label>> =
  Object.freeze({
    pending_verification: { label: "Awaiting verification", tone: "neutral" },
    active: { label: "Active", tone: "success" },
    suspended: { label: "Suspended", tone: "warning" },
    closed: { label: "Closed", tone: "neutral" },
  });

export const CLIENT_SUSPENSION_NOTE =
  "Suspending an account stops the client from using Rosuno. If the client has open requests or consultations, a compliance review item is opened for a person to decide what happens to them; nothing else is changed.";

const NOT_FOUND: Message = {
  tone: "warning",
  title: "Not found",
  body: "This could not be found. Nothing was changed.",
};

export const CLIENT_MESSAGES: Readonly<Record<ClientActionOutcome, Message>> =
  Object.freeze({
    account_suspended: {
      tone: "success",
      title: "Account suspended",
      body: "The account is suspended and the change is recorded.",
    },
    account_reactivated: {
      tone: "success",
      title: "Account reactivated",
      body: "The account is active again and the change is recorded.",
    },
    not_found: NOT_FOUND,
    state_changed: {
      tone: "warning",
      title: "Not possible now",
      body: "The account is not in a state that allows this. Nothing was changed. Reload the page to see its current state.",
    },
  });

// ---------------------------------------------------------------------------
// Attorney lifecycle
// ---------------------------------------------------------------------------

export const PROFILE_STAGE_LABELS: Readonly<Record<ProfileStage, Label>> =
  Object.freeze({
    applicant: { label: "Applicant", tone: "neutral" },
    under_review: { label: "Under review", tone: "information" },
    approved: { label: "Approved", tone: "success" },
    suspended: { label: "Suspended", tone: "warning" },
    removed: { label: "Removed", tone: "error" },
  });

export const LIFECYCLE_INTENT_LABELS: Readonly<
  Record<LifecycleIntent, string>
> = Object.freeze({
  reinstate: "Reinstate the attorney",
  remove: "Remove the attorney",
});

export const REMOVAL_NOTE =
  "Removal is final: the profile cannot be reinstated afterwards. Every record of the attorney stays as it is.";

export const REJOIN_REVIEW_NOTE =
  "A compliance review item about a possible return of a removed attorney is open for this profile. Approval and reinstatement wait until a person resolves it.";

export const LIFECYCLE_MESSAGES: Readonly<
  Record<LifecycleActionOutcome, Message>
> = Object.freeze({
  attorney_reinstated: {
    tone: "success",
    title: "Attorney reinstated",
    body: "The profile is approved again and the change is recorded.",
  },
  attorney_removed: {
    tone: "success",
    title: "Attorney removed",
    body: "The profile is removed and the change is recorded.",
  },
  stage_changed: {
    tone: "warning",
    title: "Not possible at this stage",
    body: "The profile's stage does not allow this now. Nothing was changed. Reload the page to see its current stage.",
  },
  review_required: {
    tone: "warning",
    title: "Waiting for a compliance review",
    body: "An open compliance review item about this profile must be resolved first. Nothing was changed.",
  },
});

// ---------------------------------------------------------------------------
// The compliance workspace
// ---------------------------------------------------------------------------

export const COMPLIANCE_INTRO =
  "Each section is shown only to staff who hold its capability. Dates are shown as recorded; no threshold is applied, and nothing is decided automatically.";

export const COMPLIANCE_SECTION_LABELS: Readonly<
  Record<ComplianceSection, string>
> = Object.freeze({
  under_review: "Applications under review",
  approved: "Approved profiles",
  suspended: "Suspended profiles",
  removed: "Removed profiles",
  license_expiry: "Licence end dates",
  insurance_expiry: "Insurance end dates",
  evidence_age: "Evidence age",
  discipline: "Discipline records",
  waitlist: "Attorney waitlist",
});

export const COMPLIANCE_SECTION_NOTES: Readonly<
  Record<ComplianceSection, string>
> = Object.freeze({
  under_review: "Submitted applications waiting for a review decision.",
  approved: "Profiles at the approved stage.",
  suspended: "Suspended profiles; each can be reinstated or removed.",
  removed: "Removed profiles. Removal is final.",
  license_expiry:
    "The recorded end dates of licences, soonest first (past dates included).",
  insurance_expiry:
    "The recorded end dates of insurance, soonest first (past dates included).",
  evidence_age:
    "For approved profiles where an eligibility policy is in force: the latest evidence and the date the policy's maximum evidence age is reached, soonest first; records without evidence come first.",
  discipline: "Discipline records, most recently recorded first.",
  waitlist:
    "Attorneys whose licence is in a jurisdiction on the waitlist. They have no marketplace visibility there.",
});

export const COMPLIANCE_COUNT_TITLES: Readonly<Record<string, string>> =
  Object.freeze({
    attorney_profiles: "Attorney profiles by stage",
    waitlist: "Attorney waitlist",
    compliance_reviews: "Open compliance review items",
    complaints: "Reported problems by state",
    legal_holds: "Legal Holds in force",
  });

export const COMPLIANCE_DIMENSION_LABELS: Readonly<Record<string, string>> =
  Object.freeze({
    applicant: "Applicant",
    under_review: "Under review",
    approved: "Approved",
    suspended: "Suspended",
    removed: "Removed",
    members: "Waitlist licences",
    eligibility_change_review: "Eligibility changes",
    jurisdiction_change_review: "Jurisdiction changes",
    rejoin_review: "Possible return of a removed attorney",
    client_account_review: "Client account suspended with open matters",
    opened: "Opened",
    in_review: "In review",
    escalated: "Escalated",
    resolved: "Resolved",
    active: "In force",
  });

export const POLICY_STATUS_TEXT: Readonly<Record<string, string>> =
  Object.freeze({
    draft: "Draft",
    internal_review: "Internal review",
    counsel_review: "Counsel review",
    approved: "Approved",
    scheduled: "Scheduled",
    active: "Active",
    suspended: "Suspended",
    retired: "Retired",
  });
