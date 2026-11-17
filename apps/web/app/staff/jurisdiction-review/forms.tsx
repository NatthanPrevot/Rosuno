"use client";

// Jurisdiction assessment review forms (MVP-001 S3 part 2).
//
// Each form names only the assessment it concerns and one of the two fixed
// review decisions. The server re-checks the caller's step-up, identity and
// capability before anything is sent, and the database decides the exact
// scope of the assessment's jurisdiction again, records the review once and
// audits it. Neither decision asserts governing law.

import {
  REVIEW_DECISIONS,
  type ReviewDecision,
} from "../../../src/application/staff-configuration.ts";
import {
  Button,
  Cluster,
  Stack,
} from "../../../src/presentation/design-system.tsx";
import { REVIEW_DECISION_LABELS } from "../../../src/presentation/staff-configuration-labels.ts";
import { reviewJurisdictionAssessmentAction } from "../actions.ts";
import { Outcome, useConfigurationAction } from "../outcome.tsx";

function ReviewDecisionForm({
  assessment,
  decision,
}: {
  readonly assessment: string;
  readonly decision: ReviewDecision;
}) {
  const [state, formAction, pending] = useConfigurationAction(
    reviewJurisdictionAssessmentAction,
  );
  return (
    <form action={formAction}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="assessment" value={assessment} />
        <input type="hidden" name="decision" value={decision} />
        <Cluster>
          <Button
            variant={decision === "confirmed" ? "secondary" : "tertiary"}
            type="submit"
            disabled={pending}
          >
            {REVIEW_DECISION_LABELS[decision]}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function ReviewAssessmentForms({
  assessment,
}: {
  readonly assessment: string;
}) {
  return (
    <Stack gap="tight">
      {REVIEW_DECISIONS.map((decision) => (
        <ReviewDecisionForm
          key={decision}
          assessment={assessment}
          decision={decision}
        />
      ))}
    </Stack>
  );
}
