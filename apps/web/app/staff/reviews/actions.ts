"use server";

// Review moderation server action (MVP-001 S11; MBS section 16
// "post-consultation publication workflow"; PS section 30.4).
//
// The action first asks the step-up gate (MVP-001 S2); a session that is not
// stepped up gets one fixed refusal and nothing is handed to the use case.
// Otherwise it hands the submitted form (the review and the decision) and
// this request's trusted ports to the moderation use case, which
// re-establishes the caller's fresh staff identity and moderate_reviews
// before anything is sent; the database decides again (the capability for the
// Consultation's jurisdiction and the transition) and audits the decision
// without the text. The queue is not refreshed after a decision (the review
// leaves the list it is shown in), so the fixed outcome stays in view until
// the next load. Next.js accepts this only as a POST request and applies
// its Server Action origin checks. The previous state comes back from the
// browser and is never read.

import {
  moderateReview,
  type ModerateActionState,
} from "../../../src/application/reviews.ts";
import { MODERATION_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { stepUpRefusal } from "../../account/gate.ts";

async function gated(
  operation: () => Promise<ModerateActionState>,
): Promise<ModerateActionState> {
  const refusal = await stepUpRefusal("staff");
  if (refusal !== null) {
    return refusal;
  }
  const state = await operation();
  if (state.status === "unavailable" || state.status === "unconfirmed") {
    await logRequestEvent("warn", "review.action_not_completed", {
      outcome: state.status,
    });
  }
  return state;
}

export async function moderateReviewAction(
  _previous: ModerateActionState,
  formData: FormData,
): Promise<ModerateActionState> {
  return gated(() => moderateReview(MODERATION_SOURCES, formData));
}
