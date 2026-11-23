// Review moderation (MVP-001 S11; MBS section 16 "post-consultation
// publication workflow"; PS sections 21.1 and 30.4; TA section 49).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs moderate_reviews in some scope, and the database
// lists only the reviews in the jurisdictions the caller holds it for, one
// state at a time, oldest submission first: the rating, the text, the state
// and its instants; never a client, an attorney or a Consultation. A
// submitted review can be published or rejected and a published one taken
// down; nothing is published automatically. The two query values read,
// state and page, only choose the list and the page.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  resolveModerationQueue,
  REVIEW_STATES,
} from "../../../src/application/reviews.ts";
import { MODERATION_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import {
  RATING_LABELS,
  REVIEW_STATE_LABELS,
  utcText,
} from "../../../src/presentation/completion-labels.ts";
import {
  ButtonLink,
  Cluster,
  Heading,
  Stack,
  Status,
  Surface,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../frame.tsx";
import { ModerationForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Review moderation",
  robots: { index: false, follow: false },
};

export default async function ReviewModerationPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly state?: string | string[];
    readonly page?: string | string[];
  }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { state, page } = await searchParams;
  const view = await resolveModerationQueue(MODERATION_SOURCES, state, page);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/reviews", "Review moderation");
  }
  const base = `/staff/reviews?state=${view.reviewState}`;
  return (
    <StaffFrame eyebrow="Reviews" title="Review moderation">
      <BackLink href="/staff">Staff tools</BackLink>
      <Text tone="muted">
        Reviews come from clients of completed consultations. Publish a review
        only after reading it; a published review can be taken down. Nothing is
        published automatically.
      </Text>
      <Cluster>
        {REVIEW_STATES.map((entry) => (
          <ButtonLink
            key={entry}
            variant={entry === view.reviewState ? "primary" : "secondary"}
            href={`/staff/reviews?state=${entry}`}
            aria-current={entry === view.reviewState ? "page" : undefined}
          >
            {REVIEW_STATE_LABELS[entry].label}
          </ButtonLink>
        ))}
      </Cluster>
      {view.reviews.length === 0 ? (
        <Text>
          {view.pager.page === 1
            ? "There are no reviews in this list."
            : "There are no reviews on this page."}
        </Text>
      ) : (
        view.reviews.map((review) => (
          <Surface key={review.id} labelledBy={`queued-${review.id}`}>
            <Stack gap="tight">
              <Heading as="h2" size="sm" id={`queued-${review.id}`}>
                {`Rating: ${RATING_LABELS[review.rating]}`}
              </Heading>
              <Cluster>
                <Status tone={REVIEW_STATE_LABELS[review.state].tone}>
                  {REVIEW_STATE_LABELS[review.state].label}
                </Status>
              </Cluster>
              {review.text === null ? (
                <Text tone="muted">No text.</Text>
              ) : (
                <Text>{review.text}</Text>
              )}
              <Text size="small" tone="muted">
                {`Submitted ${utcText(review.submittedAt)}${review.publishedAt === null ? "" : `; published ${utcText(review.publishedAt)}`}`}
              </Text>
              <ModerationForm review={review.id} state={review.state} />
            </Stack>
          </Surface>
        ))
      )}
      <Cluster>
        {view.pager.page > 1 ? (
          <ButtonLink
            variant="secondary"
            href={`${base}&page=${view.pager.page - 1}`}
          >
            Previous page
          </ButtonLink>
        ) : null}
        {view.pager.hasNext ? (
          <ButtonLink
            variant="secondary"
            href={`${base}&page=${view.pager.page + 1}`}
          >
            Next page
          </ButtonLink>
        ) : null}
      </Cluster>
    </StaffFrame>
  );
}
