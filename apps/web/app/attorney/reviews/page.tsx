// The attorney's published reviews (MVP-001 S11; MBS section 16 "Verified
// Client Review"; DM section 9; PS section 21.1).
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (aal2); the unchanged Security Shell then decides access
// and the database answers only the published reviews about the calling
// attorney: the rating, the text and the publication instant. Never the
// client, the Consultation, a submitted or a rejected review, and no stored
// aggregate (PS P3).
//
// DEV-001: the owner's UI/UX design (UIUX-HANDOFF-P2 build_p8, the attorney
// workspace Public profile, reviews): the workspace frame around the
// published reviews as the design's review rows, with the section's switch
// to the profile. Clients are never named. A visitor the page does not admit
// sees the design's signed-out panel.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveAttorneyReviews } from "../../../src/application/reviews.ts";
import { ATTORNEY_REVIEW_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import {
  AttorneyGate,
  AttorneyWorkspace,
  Card,
  PROFILE_PAGES,
} from "../../../src/presentation/attorney-workspace.tsx";
import {
  RATING_LABELS,
  utcText,
} from "../../../src/presentation/completion-labels.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { requireSteppedUp } from "../../account/gate.ts";

export const metadata: Metadata = {
  title: "Your reviews",
  robots: { index: false, follow: false },
};

const BACK = (
  <Cluster>
    <ButtonLink variant="tertiary" href="/attorney">
      Back to your workspace
    </ButtonLink>
  </Cluster>
);

function GateFrame({ children }: { readonly children: ReactNode }) {
  return (
    <AttorneyGate
      titleId="attorney-reviews-title"
      title="Your published reviews"
    >
      {children}
      {BACK}
    </AttorneyGate>
  );
}

export default async function AttorneyReviewsPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const view = await resolveAttorneyReviews(ATTORNEY_REVIEW_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <GateFrame>
        <Text tone="muted">Sign in to see your reviews.</Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </GateFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <GateFrame>
        <Alert tone="warning" title="Not available" role="status">
          This account does not have published reviews.
        </Alert>
      </GateFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "review.view_unavailable", {
      route: "/attorney/reviews",
      outcome: view.status,
    });
    return (
      <GateFrame>
        <Alert tone="error" title="Something went wrong" role="alert">
          Your reviews could not be shown right now. Please try again later.
        </Alert>
      </GateFrame>
    );
  }
  return (
    <AttorneyWorkspace
      section="profile"
      titleId="attorney-reviews-title"
      title="Your published reviews"
      description="What clients see on Rosuno"
      width="narrow"
      pages={{
        label: "Public profile pages",
        links: PROFILE_PAGES,
        current: "/attorney/reviews",
      }}
    >
      <Card
        id="attorney-reviews-list"
        title="Reviews"
        count={view.reviews.length}
      >
        <Text tone="muted">
          Reviews come from clients of your completed consultations and are
          published after Rosuno reviews them. Clients are never named.
        </Text>
        {view.reviews.length === 0 ? (
          <div className="w-calm">
            <span className="sm b">You have no published review yet.</span>
          </div>
        ) : (
          <ul className="w-feed aw-reviews">
            {view.reviews.map((review, index) => (
              <li key={`${review.publishedAt}-${index}`}>
                <span className="col grow l-g0-minw0 aw-review">
                  <h2 className="sm b" id={`attorney-review-${index}`}>
                    {`Rating: ${RATING_LABELS[review.rating]}`}
                  </h2>
                  {review.text === null ? null : (
                    <p className="sm aw-review-text">{review.text}</p>
                  )}
                  <span className="xs subtle">
                    {`Published ${utcText(review.publishedAt)}`}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {BACK}
    </AttorneyWorkspace>
  );
}
