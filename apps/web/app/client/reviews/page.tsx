// The client's reviews (MVP-001 S11; MBS section 16 "Verified Client
// Review"; PS section 21.1; TA section 49).
//
// Rendered on the server for every request and never indexed. The verified
// client of the request decides access; the database answers only the
// client's own completed Consultations, each with its review or none. A
// completed Consultation without a review offers the review form (the
// database decides eligibility again on submission); a submitted review shows
// its state: waiting for review, published or not published. Nothing about
// the attorney is shown and the client never chooses one.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveClientReviews } from "../../../src/application/reviews.ts";
import { CLIENT_REVIEW_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import {
  RATING_LABELS,
  REVIEW_NOTE,
  REVIEW_STATE_LABELS,
  utcText,
} from "../../../src/presentation/completion-labels.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Eyebrow,
  Heading,
  Page,
  Stack,
  Status,
  Surface,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { ReviewForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Your reviews",
  robots: { index: false, follow: false },
};

function Frame({ children }: { readonly children: ReactNode }) {
  return (
    <Page density="client">
      <Surface emphasis="raised" labelledBy="reviews-title">
        <Stack>
          <Eyebrow>Client workspace</Eyebrow>
          <Heading as="h1" size="lg" id="reviews-title">
            Your reviews
          </Heading>
          {children}
          <Cluster>
            <ButtonLink variant="tertiary" href="/client">
              Back to your workspace
            </ButtonLink>
          </Cluster>
        </Stack>
      </Surface>
    </Page>
  );
}

export default async function ClientReviewsPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const view = await resolveClientReviews(CLIENT_REVIEW_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <Frame>
        <Text tone="muted">Sign in to see and write your reviews.</Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </Frame>
    );
  }
  if (view.status === "denied") {
    return (
      <Frame>
        <Alert tone="warning" title="Not available" role="status">
          This account cannot write client reviews.
        </Alert>
      </Frame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "review.view_unavailable", {
      route: "/client/reviews",
      outcome: view.status,
    });
    return (
      <Frame>
        <Alert tone="error" title="Something went wrong" role="alert">
          Your reviews could not be shown right now. Please try again later.
        </Alert>
      </Frame>
    );
  }
  return (
    <Frame>
      <Text tone="muted">{REVIEW_NOTE}</Text>
      {view.consultations.length === 0 ? (
        <Text>You have no completed consultation to review.</Text>
      ) : (
        view.consultations.map((entry) => (
          <Surface
            key={entry.consultationId}
            labelledBy={`review-${entry.consultationId}`}
          >
            <Stack gap="tight">
              <Heading as="h2" size="md" id={`review-${entry.consultationId}`}>
                {`Consultation ended ${utcText(entry.endedAt)}`}
              </Heading>
              <Cluster>
                <ButtonLink
                  variant="tertiary"
                  href={`/client/consultations/${entry.consultationId}`}
                >
                  Open the consultation
                </ButtonLink>
              </Cluster>
              <ReviewForm
                consultationId={entry.consultationId}
                reviewed={entry.review !== null}
              />
              {entry.review === null ? null : (
                <>
                  <Cluster>
                    <Status tone={REVIEW_STATE_LABELS[entry.review.state].tone}>
                      {REVIEW_STATE_LABELS[entry.review.state].label}
                    </Status>
                  </Cluster>
                  <Text>{`Rating: ${RATING_LABELS[entry.review.rating]}`}</Text>
                  {entry.review.text === null ? null : (
                    <Text size="small">{entry.review.text}</Text>
                  )}
                  <Text size="small" tone="muted">
                    {`Submitted ${utcText(entry.review.submittedAt)}`}
                  </Text>
                </>
              )}
            </Stack>
          </Surface>
        ))
      )}
    </Frame>
  );
}
