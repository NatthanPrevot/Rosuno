// DEV-001: the development test configuration (owner request).
//
// Pure and dependency-free: the thirteen development policy versions the
// owner's staging runbook (section A10) creates by hand, as frozen constants,
// so one staff action can create them through the existing policy creation
// use case. They are development-only test values: they decide no product,
// legal, regulatory, payment or eligibility policy, they are created only as
// development configuration (never approved, never selected in production,
// refused there by the application and by the database), and every label
// starts with the fixed prefix below. No id is written here: "jurisdiction"
// names the jurisdiction the development regulatory mode maps to, resolved
// at run time from the caller's own reads, and "global" names the
// jurisdiction-free scope.

export const DEVELOPMENT_TEST_LABEL_PREFIX = "DEV TEST";

// The one value the confirmation posts (the server action refuses any other).
export const DEVELOPMENT_TEST_CONFIRMATION = "create";

export type DevelopmentTestScope = "jurisdiction" | "global";

export type DevelopmentTestDefinition = {
  readonly key: string;
  readonly policyTypeCode: string;
  // The policy type as the confirmation names it.
  readonly title: string;
  readonly scope: DevelopmentTestScope;
  // True for the versions created with the development regulatory mode.
  readonly regulatoryMode: boolean;
  readonly versionLabel: string;
  readonly parameters: Readonly<Record<string, unknown>>;
};

function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) {
      frozen(entry);
    }
    Object.freeze(value);
  }
  return value;
}

function definition(
  key: string,
  policyTypeCode: string,
  title: string,
  scope: DevelopmentTestScope,
  regulatoryMode: boolean,
  parameters: Record<string, unknown>,
): DevelopmentTestDefinition {
  return {
    key,
    policyTypeCode,
    title,
    scope,
    regulatoryMode,
    versionLabel: `${DEVELOPMENT_TEST_LABEL_PREFIX} ${key.replaceAll("-", " ")} v1`,
    parameters,
  };
}

// Exactly the runbook's types, scopes, regulatory mode use and JSON
// parameters (OWNER-STAGING-RUNBOOK.md, A10.1 to A10.13), in its order.
export const DEVELOPMENT_TEST_DEFINITIONS: readonly DevelopmentTestDefinition[] =
  frozen([
    definition(
      "eligibility",
      "eligibility",
      "Eligibility",
      "jurisdiction",
      false,
      {
        schema: "rosuno.attorney_eligibility.v1",
        license: {
          qualifying_reported_statuses: ["synthetic-active"],
          evidence_max_age_days: 30,
        },
        insurance: {
          required: false,
          evidence_max_age_days: null,
          minimum_per_occurrence_minor: null,
          minimum_aggregate_minor: null,
          currency_code: null,
        },
        discipline: {
          disqualifying_statuses: ["synthetic-revoked"],
          cleared_statuses: ["synthetic-cleared"],
        },
        practice_area: {
          authorisation_required: true,
        },
      },
    ),
    definition(
      "scheduling",
      "scheduling",
      "Scheduling",
      "jurisdiction",
      false,
      {
        minimum_notice_seconds: 1800,
        instant_request_response_window_seconds: 300,
        scheduled_request_response_window_seconds: 3600,
        hold_response_window_seconds: 3600,
        hold_pre_slot_interval_seconds: 0,
        pending_hold_cap: 50,
        consultation_join_window_seconds: 600,
        consultation_overrun_seconds: 300,
      },
    ),
    definition("bookability", "bookability", "Bookability", "global", false, {
      presence_window_seconds: 120,
    }),
    definition("referral", "referral", "Referral", "jurisdiction", false, {
      outcome_codes: ["synthetic_closed"],
      request_message_maximum_characters: 200,
    }),
    definition(
      "fee",
      "fee",
      "Fee (jurisdiction amounts)",
      "jurisdiction",
      false,
      {
        currency_code: "USD",
        quote_validity_seconds: 3600,
        listed_price_minimum_minor: 1000,
        listed_price_maximum_minor: 100000,
        rounding: "half_up",
        platform_fee: {
          basis_points: 1000,
          fixed_minor: 0,
          minimum_minor: null,
          maximum_minor: null,
        },
        client_fee: {
          basis_points: 250,
          fixed_minor: 50,
          minimum_minor: 100,
          maximum_minor: 2000,
        },
        other_required_fee: {
          basis_points: 100,
          fixed_minor: 0,
          minimum_minor: null,
          maximum_minor: null,
        },
      },
    ),
    definition(
      "fee-options",
      "fee",
      "Fee (platform options)",
      "global",
      false,
      {
        permitted_durations_minutes: [30, 60, 90],
        permitted_modalities: ["video"],
      },
    ),
    definition(
      "notification",
      "notification",
      "Notification",
      "global",
      false,
      {
        critical_notification_types: ["request_accepted"],
        acknowledgement_required_types: ["consultation_ready"],
      },
    ),
    definition("complaint", "complaint", "Complaint", "jurisdiction", false, {
      category_codes: ["synthetic_category", "synthetic_other_category"],
      resolution_codes: ["synthetic_resolution"],
    }),
    definition(
      "payment-flow",
      "payment_flow",
      "Payment flow",
      "jurisdiction",
      true,
      {
        instant: {
          authorization: "before_attorney_decision",
          capture: "at_attorney_acceptance",
        },
        scheduled: {
          authorization: "before_attorney_decision",
          capture: "at_attorney_acceptance",
        },
      },
    ),
    definition("payment", "payment", "Payment", "jurisdiction", true, {}),
    definition(
      "cancellation",
      "cancellation",
      "Cancellation",
      "jurisdiction",
      true,
      {},
    ),
    definition("refund", "refund", "Refund", "jurisdiction", true, {}),
    definition("engagement", "engagement", "Engagement", "jurisdiction", true, {
      consultation_creation: "attorney_acceptance",
      engagement_effective: "at_consultation_start",
      post_consultation_message_window_seconds: 86400,
    }),
  ]);
