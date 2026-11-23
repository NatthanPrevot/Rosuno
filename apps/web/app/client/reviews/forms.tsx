"use client";

// The client's review form (MVP-001 S11).
//
// The form names only the Consultation (a hidden field) and posts the
// client's own rating and optional text. It never names an attorney: the
// database derives the attorney from the Consultation. The server decides
// afresh on submission and the form shows only the fixed message for the
// state its action returns.

import { useActionState } from "react";

import {
  INITIAL_SUBMIT_STATE,
  MAX_REVIEW_TEXT,
  RATINGS,
  type SubmitActionState,
} from "../../../src/application/reviews.ts";
import {
  messageOf,
  RATING_LABELS,
  SUBMIT_MESSAGES,
} from "../../../src/presentation/completion-labels.ts";
import {
  Alert,
  Button,
  Cluster,
  SelectField,
  Stack,
  TextAreaField,
} from "../../../src/presentation/design-system.tsx";
import { submitReviewAction } from "./actions.ts";

export function ReviewForm({
  consultationId,
  reviewed,
}: {
  readonly consultationId: string;
  // Whether the Consultation already has the client's review: the panel
  // stays mounted after a submission refreshes the page, so the fixed
  // outcome message stays in view, and the form is no longer offered.
  readonly reviewed: boolean;
}) {
  const [state, action, pending] = useActionState<SubmitActionState, FormData>(
    submitReviewAction,
    INITIAL_SUBMIT_STATE,
  );
  const message = messageOf(state, SUBMIT_MESSAGES);
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
      {reviewed ? null : (
        <form action={action}>
          <Stack gap="tight">
            <input type="hidden" name="consultation" value={consultationId} />
            <SelectField
              id={`rating-${consultationId}`}
              name="rating"
              label="Rating"
              required
              defaultValue=""
            >
              <option value="" disabled>
                Choose a rating
              </option>
              {RATINGS.map((rating) => (
                <option key={rating} value={String(rating)}>
                  {RATING_LABELS[rating]}
                </option>
              ))}
            </SelectField>
            <TextAreaField
              id={`text-${consultationId}`}
              name="text"
              label="Your review (optional)"
              hint={`At most ${MAX_REVIEW_TEXT.toLocaleString("en-US")} characters. Do not include personal or confidential details.`}
              maxLength={MAX_REVIEW_TEXT}
            />
            <Cluster>
              <Button variant="primary" type="submit" disabled={pending}>
                Submit the review
              </Button>
            </Cluster>
          </Stack>
        </form>
      )}
    </Stack>
  );
}
