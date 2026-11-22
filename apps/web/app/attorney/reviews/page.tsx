// The attorney's published reviews (MVP-001 S11; MBS section 16 "Verified
// Client Review"; DM section 9; PS section 21.1).
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (aal2); the unchanged Security Shell then decides access
// and the database answers only the published reviews about the calling
// attorney: the rating, the text and the publication instant. Never the
// client, the Consultation, a submitted or a rejected review, and no stored
// aggregate (PS P3).

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveAttorneyReviews } from "../../../src/application/reviews.ts";
import { ATTORNEY_REVIEW_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import {
  RATING_LABELS,
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
  Surface,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { requireSteppedUp } from "../../account/gate.ts";

export const metadata: Metadata = {
  title: "Your reviews",
  robots: { index: false, follow: false },
};

function Frame({ children }: { readonly children: ReactNode }) {
  return (
    <Page density="attorney">
      <Surface emphasis="raised" labelledBy="attorney-reviews-title">
        <Stack>
          <Eyebrow>Attorney workspace</Eyebrow>
          <Heading as="h1" size="lg" id="attorney-reviews-title">
            Your published reviews
          </Heading>
          {children}
          <Cluster>
            <ButtonLink variant="tertiary" href="/attorney">
              Back to your workspace
            </ButtonLink>
          </Cluster>
        </Stack>
      </Surface>
    </Page>
  );
}

export default async function AttorneyReviewsPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const view = await resolveAttorneyReviews(ATTORNEY_REVIEW_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <Frame>
        <Text tone="muted">Sign in to see your reviews.</Text>
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
          This account does not have published reviews.
        </Alert>
      </Frame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "review.view_unavailable", {
      route: "/attorney/reviews",
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
      <Text tone="muted">
        Reviews come from clients of your completed consultations and are
        published after Rosuno reviews them. Clients are never named.
      </Text>
      {view.reviews.length === 0 ? (
        <Text>You have no published review yet.</Text>
      ) : (
        view.reviews.map((review, index) => (
          <Surface
            key={`${review.publishedAt}-${index}`}
            labelledBy={`attorney-review-${index}`}
          >
            <Stack gap="tight">
              <Heading as="h2" size="sm" id={`attorney-review-${index}`}>
                {`Rating: ${RATING_LABELS[review.rating]}`}
              </Heading>
              {review.text === null ? null : <Text>{review.text}</Text>}
              <Text size="small" tone="muted">
                {`Published ${utcText(review.publishedAt)}`}
              </Text>
            </Stack>
          </Surface>
        ))
      )}
    </Frame>
  );
}
