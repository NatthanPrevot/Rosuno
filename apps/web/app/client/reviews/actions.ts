"use server";

// The client's review action (MVP-001 S11; MBS section 16 "Verified Client
// Review"; TA section 49).
//
// The action hands the submitted form (the Consultation, the rating and the
// optional text) and this request's trusted ports to the review use case,
// which re-establishes the verified client on the server, checks the
// environment binding and lets the database decide: the Consultation's own
// client, that it is completed, one review per Consultation and the attorney
// (derived from the Consultation, never sent). Nothing is published on
// submission. Next.js accepts this only as a POST request and applies its
// Server Action origin checks. The previous state comes back from the browser
// and is never read. An outcome that is unavailable or unconfirmed writes one
// log line naming the action and the outcome, with nothing the client wrote.

import { revalidatePath } from "next/cache";

import {
  submitClientReview,
  type SubmitActionState,
} from "../../../src/application/reviews.ts";
import { CLIENT_REVIEW_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";

export async function submitReviewAction(
  _previous: SubmitActionState,
  formData: FormData,
): Promise<SubmitActionState> {
  const state = await submitClientReview(CLIENT_REVIEW_SOURCES, formData);
  if (state.status === "unavailable" || state.status === "unconfirmed") {
    await logRequestEvent("warn", "review.action_not_completed", {
      operation: "submitReview",
      outcome: state.status,
    });
  }
  if (state.status === "outcome") {
    revalidatePath("/client/reviews");
  }
  return state;
}
