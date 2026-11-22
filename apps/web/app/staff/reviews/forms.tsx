"use client";

// Review moderation forms (MVP-001 S11).
//
// Each form names only the review and the decision (publish, or reject: a
// submitted review is not published, a published one is taken down). The
// server re-checks the caller's step-up, identity and capability, and the
// database decides the transition again. The form shows only the fixed
// message for the state its action returns.

import { useActionState } from "react";

import {
  INITIAL_MODERATE_STATE,
  type ModerateActionState,
  type ReviewState,
} from "../../../src/application/reviews.ts";
import {
  messageOf,
  MODERATE_MESSAGES,
} from "../../../src/presentation/completion-labels.ts";
import {
  Alert,
  Button,
  Cluster,
  Stack,
} from "../../../src/presentation/design-system.tsx";
import { moderateReviewAction } from "./actions.ts";

export function ModerationForm({
  review,
  state: reviewState,
}: {
  readonly review: string;
  readonly state: ReviewState;
}) {
  const [state, action, pending] = useActionState<
    ModerateActionState,
    FormData
  >(moderateReviewAction, INITIAL_MODERATE_STATE);
  const message = messageOf(state, MODERATE_MESSAGES);
  if (reviewState === "rejected") {
    return null;
  }
  return (
    <Stack gap="tight">
      {message === null ? null : (
        <Alert
          tone={message.tone}
          title={message.title}
          role={message.tone === "error" ? "alert" : "status"}
        >
          {message.body}
        </Alert>
      )}
      <Cluster>
        {reviewState === "submitted" ? (
          <form action={action}>
            <input type="hidden" name="review" value={review} />
            <input type="hidden" name="decision" value="publish" />
            <Button variant="primary" type="submit" disabled={pending}>
              Publish
            </Button>
          </form>
        ) : null}
        <form action={action}>
          <input type="hidden" name="review" value={review} />
          <input type="hidden" name="decision" value="reject" />
          <Button variant="secondary" type="submit" disabled={pending}>
            {reviewState === "published" ? "Take down" : "Reject"}
          </Button>
        </form>
      </Cluster>
    </Stack>
  );
}
