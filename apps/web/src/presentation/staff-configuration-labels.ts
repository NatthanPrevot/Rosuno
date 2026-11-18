// Staff configuration presentation wording (MVP-001 S1).
//
// Fixed interface wording only: the names of the staff surfaces, the labels
// of the database's own lifecycle states, and one fixed message for every
// action outcome and refusal reason. No policy value, jurisdiction, launch
// rule, or capability decision is written here; every such value is
// configuration read from the database.

import type {
  Ambiguity,
  AssessmentReviewStatus,
  AssessmentSource,
  ConfigurationActionState,
  GrantState,
  JobGroup,
  JobState,
  LifecycleState,
  PolicyStatus,
  RefusalReason,
  ReviewDecision,
  ReviewGroup,
  StaffSurface,
} from "../application/staff-configuration.ts";
import type { EnvironmentBinding } from "../application/environment-binding.ts";
import type { Tone } from "./design-system.tsx";

type Label = { readonly label: string; readonly tone: Tone };

export const SURFACE_LINKS: Readonly<
  Record<
    StaffSurface,
    {
      readonly href: string;
      readonly title: string;
      readonly summary: string;
    }
  >
> = Object.freeze({
  verification: {
    href: "/staff/verification",
    title: "Verification review",
    summary: "Review attorney applications and professional records.",
  },
  policies: {
    href: "/staff/policies",
    title: "Policy configuration",
    summary:
      "Draft, review, approve, schedule, and end policy versions and their authority references.",
  },
  jurisdictions: {
    href: "/staff/jurisdictions",
    title: "Jurisdictions",
    summary:
      "Create jurisdictions, change their lifecycle, and add service areas.",
  },
  launch: {
    href: "/staff/launch",
    title: "Launch gates and authorization",
    summary:
      "Define launch gates, record their evaluations, and grant or revoke launch authorization.",
  },
  catalog: {
    href: "/staff/catalog",
    title: "Practice-area catalog",
    summary: "Add practice areas and make them active or inactive.",
  },
  capabilities: {
    href: "/staff/capabilities",
    title: "Staff capabilities",
    summary: "Grant and revoke staff capabilities.",
  },
  intake: {
    href: "/staff/intake-configuration",
    title: "Intake configuration",
    summary: "Publish new intake question-set versions.",
  },
  // MVP-001 S3 part 2.
  "jurisdiction-review": {
    href: "/staff/jurisdiction-review",
    title: "Jurisdiction assessment review",
    summary:
      "Review the jurisdictions submitted Intakes name, as suggestions that may be relevant, never as governing law.",
  },
  jobs: {
    href: "/staff/jobs",
    title: "Operational jobs",
    summary:
      "See escalated, waiting, and finished background jobs, and retry or cancel them.",
  },
  // MVP-001 S7.
  finance: {
    href: "/staff/finance",
    title: "Finance",
    summary:
      "See transactions, ledger entries and reconciliation exceptions, request refunds, and ask for reconciliation.",
  },
});

// MVP-001 S2: the operational job states and the groups the job view lists.
export const JOB_STATE_LABELS: Readonly<Record<JobState, Label>> =
  Object.freeze({
    pending: { label: "Waiting", tone: "information" },
    running: { label: "Running", tone: "information" },
    completed: { label: "Completed", tone: "success" },
    escalated: { label: "Escalated", tone: "error" },
    cancelled: { label: "Cancelled", tone: "neutral" },
  });

export const JOB_GROUP_LINKS: Readonly<
  Record<JobGroup, { readonly href: string; readonly title: string }>
> = Object.freeze({
  escalated: { href: "/staff/jobs", title: "Escalated" },
  open: { href: "/staff/jobs?state=open", title: "Waiting or running" },
  finished: { href: "/staff/jobs?state=finished", title: "Finished" },
});

// MVP-001 S3 part 2: the jurisdiction assessment review. A review records
// whether a named jurisdiction may be relevant; it never asserts governing
// law, and several named jurisdictions stay several.
export const REVIEW_GROUP_LINKS: Readonly<
  Record<ReviewGroup, { readonly href: string; readonly title: string }>
> = Object.freeze({
  unreviewed: { href: "/staff/jurisdiction-review", title: "Needs review" },
  unnamed: {
    href: "/staff/jurisdiction-review?group=unnamed",
    title: "No jurisdiction named",
  },
});

export const ASSESSMENT_SOURCE_LABELS: Readonly<
  Record<AssessmentSource, string>
> = Object.freeze({
  client_statement: "Stated by the client at submission",
  ai_suggestion: "A suggestion the client confirmed",
});

export const ASSESSMENT_STATUS_LABELS: Readonly<
  Record<AssessmentReviewStatus, Label>
> = Object.freeze({
  unreviewed: { label: "Not reviewed", tone: "information" },
  confirmed: { label: "Confirmed: may be relevant", tone: "success" },
  not_confirmed: { label: "Not confirmed", tone: "neutral" },
});

export const AMBIGUITY_LABELS: Readonly<Record<Ambiguity, Label>> =
  Object.freeze({
    none: { label: "No jurisdiction named", tone: "warning" },
    one: { label: "One jurisdiction named", tone: "neutral" },
    several: {
      label: "Several jurisdictions named; none is chosen",
      tone: "warning",
    },
  });

export const REVIEW_DECISION_LABELS: Readonly<Record<ReviewDecision, string>> =
  Object.freeze({
    confirmed: "Confirm: may be relevant",
    not_confirmed: "Mark as not confirmed",
  });

export const REVIEW_NOTE =
  "A review records whether a jurisdiction an Intake names may be relevant. It never decides which law applies, never chooses a jurisdiction, and never changes what the client submitted. Client identity and Intake content are not shown here.";

export const POLICY_STATUS_LABELS: Readonly<Record<PolicyStatus, Label>> =
  Object.freeze({
    draft: { label: "Draft", tone: "neutral" },
    internal_review: { label: "Internal review", tone: "information" },
    counsel_review: { label: "Counsel review", tone: "information" },
    approved: { label: "Approved", tone: "success" },
    scheduled: { label: "Scheduled", tone: "success" },
    active: { label: "Active", tone: "success" },
    suspended: { label: "Suspended", tone: "warning" },
    retired: { label: "Retired", tone: "neutral" },
  });

export const LIFECYCLE_LABELS: Readonly<Record<LifecycleState, Label>> =
  Object.freeze({
    unsupported: { label: "Unsupported", tone: "neutral" },
    waitlist: { label: "Waitlist", tone: "neutral" },
    staged: { label: "Staged", tone: "information" },
    ready: { label: "Ready (not live)", tone: "information" },
    live: { label: "Live", tone: "success" },
    restricted: { label: "Restricted", tone: "warning" },
    suspended: { label: "Suspended", tone: "warning" },
  });

export const GRANT_STATE_LABELS: Readonly<Record<GrantState, Label>> =
  Object.freeze({
    current: { label: "Current", tone: "success" },
    scheduled: { label: "Not yet in effect", tone: "information" },
    expired: { label: "Expired", tone: "neutral" },
    revoked: { label: "Revoked", tone: "neutral" },
    resource_scoped: {
      label: "Resource-scoped (not used here)",
      tone: "neutral",
    },
  });

export const ENVIRONMENT_LABELS: Readonly<Record<EnvironmentBinding, string>> =
  Object.freeze({
    development: "Development database",
    staging: "Staging database",
    production: "Production database",
    unrecorded: "Environment not recorded",
    mismatch: "Environment does not match this deployment",
  });

// Labels for the known verification and evaluation states; anything else is
// shown as recorded.
export function recordedStateLabel(value: string): Label {
  switch (value) {
    case "verified":
      return { label: "Verified", tone: "success" };
    case "rejected":
      return { label: "Rejected", tone: "error" };
    case "unverified":
      return { label: "Not yet verified", tone: "warning" };
    case "passed":
      return { label: "Passed", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "error" };
    default:
      return { label: `Recorded as ${value}`, tone: "neutral" };
  }
}

const REASON_MESSAGES: Readonly<
  Record<RefusalReason, { readonly title: string; readonly body: string }>
> = Object.freeze({
  invalid: {
    title: "Values refused",
    body: "The database refused these values, so nothing was saved. Check the entries and the record they refer to.",
  },
  conflict: {
    title: "Changed meanwhile or already exists",
    body: "The record changed since this page was shown, or the same entry already exists. Nothing was saved. Refresh the page and try again.",
  },
  locked: {
    title: "Not possible in this state",
    body: "The record's current state does not allow this change. Nothing was saved.",
  },
  not_found: {
    title: "Record not found",
    body: "The record no longer exists or is not available to you. Nothing was saved.",
  },
  environment_unrecorded: {
    title: "Environment not recorded",
    body: "This database has not recorded its environment, so policy changes are refused. Nothing was saved.",
  },
  environment_mismatch: {
    title: "Environment mismatch",
    body: "This deployment's settings do not match the database's recorded environment, so policy changes are refused. Nothing was saved.",
  },
  environment_refused: {
    title: "Development configuration refused here",
    body: "Development configuration can be created only in a development or staging database. Nothing was saved.",
  },
  invalid_transition: {
    title: "Transition not allowed",
    body: "The record's current state does not allow that move: a policy version follows its lifecycle, an operational job can be retried only while escalated, and only an unfinished job can be cancelled. Nothing was saved.",
  },
  authority_unverified: {
    title: "Verified authority required",
    body: "Approval needs at least one authority reference verified by staff. Nothing was saved.",
  },
  effective_period_required: {
    title: "Effective period required",
    body: "Approval needs an effective start; scheduling needs a future start; activation needs a start that has been reached and an end that has not. Nothing was saved.",
  },
  parameters_invalid: {
    title: "Parameters not valid for approval",
    body: "Approval checks the parameters against what the version's policy type and scope require, and they do not match. Revise the draft parameters and try again. Nothing was saved.",
  },
  already_ended: {
    title: "Already ended",
    body: "This version already has an end. An end is set only once. Nothing was saved.",
  },
  launch_gates_unmet: {
    title: "Launch gates not met",
    body: "Every required launch gate's latest evaluation must have passed, and at least one gate must be required. Nothing was saved.",
  },
  launch_authorization_required: {
    title: "Launch authorization required",
    body: "A jurisdiction becomes live only with an active human launch authorization. Nothing was saved.",
  },
  already_authorized: {
    title: "Already authorized",
    body: "This jurisdiction already has an active launch authorization. Nothing was saved.",
  },
  already_revoked: {
    title: "Already revoked",
    body: "This was already revoked. Nothing was saved.",
  },
  jurisdiction_live: {
    title: "Jurisdiction is live",
    body: "The only active launch authorization of a live jurisdiction cannot be revoked. Change its lifecycle state first. Nothing was saved.",
  },
  self_grant_refused: {
    title: "You cannot grant yourself a capability",
    body: "Another staff member with capability administration must make this grant. Nothing was saved.",
  },
  target_not_active_staff: {
    title: "Not an active staff member",
    body: "Capabilities can be granted only to an active User with an active staff profile. Nothing was saved.",
  },
  duplicate_version: {
    title: "Version key already used",
    body: "A question-set version with this key is already published. Choose a new key. Nothing was saved.",
  },
  // MVP-001 S3 part 2.
  already_reviewed: {
    title: "Already reviewed",
    body: "This assessment was already reviewed. A review is recorded once. Nothing was saved.",
  },
  not_reviewable: {
    title: "Not open for review",
    body: "Only assessments of submitted or active Intakes that have not expired are reviewed. Nothing was saved.",
  },
});

export type OutcomeMessage = {
  readonly tone: Tone;
  readonly title: string;
  readonly body: string;
};

// The fixed message for each action state; null shows nothing.
export function outcomeMessage(
  state: ConfigurationActionState,
): OutcomeMessage | null {
  switch (state.status) {
    case "idle":
      return null;
    case "recorded":
      return {
        tone: "success",
        title: "Recorded",
        body: "The change and its audit record were saved.",
      };
    case "unchanged":
      return {
        tone: "information",
        title: "Already in that state",
        body: "The record was already in the requested state, so nothing was changed.",
      };
    case "invalid":
      return {
        tone: "error",
        title: "Check the form",
        body: "Some entries need attention. Nothing was sent.",
      };
    case "refused":
      return { tone: "warning", ...REASON_MESSAGES[state.reason] };
    case "not-saved":
      return {
        tone: "warning",
        title: "Nothing was saved",
        body: "The database refused the change as a whole. Refresh the page and review the record before trying again.",
      };
    case "unconfirmed":
      return {
        tone: "error",
        title: "Could not be confirmed",
        body: "This change may or may not have been saved; it is never saved in part. Refresh the page to see the current record before trying again.",
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
        title: "Not authorized",
        body: "Your current staff capabilities do not cover this change.",
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
        body: "Nothing was sent. This change needs a sign-in confirmed with a code from your authenticator app. Reload this page to confirm it, then try again.",
      };
  }
}

// A timestamp as "YYYY-MM-DD HH:MM UTC".
export function utcDateTime(timestamp: string): string {
  return `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// A period as "from … until …", "from … (open-ended)", or "Not set".
export function periodLabel(from: string | null, until: string | null): string {
  if (from === null) {
    return until === null ? "Not set" : `Until ${utcDateTime(until)}`;
  }
  return until === null
    ? `From ${utcDateTime(from)} (open-ended)`
    : `From ${utcDateTime(from)} until ${utcDateTime(until)}`;
}
