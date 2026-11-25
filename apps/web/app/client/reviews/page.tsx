// The client's reviews (MVP-001 S11; MBS section 16 "Verified Client
// Review"; PS section 21.1; TA section 49).
//
// Rendered on the server for every request and never indexed. The verified
// client of the request decides access; the database answers only the
// client's own completed Consultations, each with its review or none. A
// completed Consultation without a review offers the review form (the
// database decides eligibility again on submission); a submitted review shows
// its state: waiting for review, published or not published. Nothing about
// the attorney is shown and the client never chooses one. DEV-001: the
// owner's UI/UX design, inside the client account (beside My consultations,
// which links here); the review form is unchanged.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveClientReviews } from "../../../src/application/reviews.ts";
import { getShellView } from "../../../src/application/shell.ts";
import { CLIENT_REVIEW_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../src/infrastructure/identity/server-session-source.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import {
  ClientAccount,
  ClientGate,
  ClientPill,
  dateText,
  TIMES_IN_UTC,
  whenText,
} from "../../../src/presentation/client-account.tsx";
import {
  RATING_LABELS,
  REVIEW_NOTE,
  REVIEW_STATE_LABELS,
} from "../../../src/presentation/completion-labels.ts";
import { Alert } from "../../../src/presentation/design-system.tsx";
import { SitePage } from "../../../src/presentation/site-chrome.tsx";
import { signOut } from "../../sign-in/actions.ts";
import { ReviewForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Your reviews",
  robots: { index: false, follow: false },
};

export default async function ClientReviewsPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const shell = await getShellView(SUPABASE_SERVER_SESSION_SOURCE);
  const view = await resolveClientReviews(CLIENT_REVIEW_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Sign in to continue">
          <p className="sm muted">Sign in to see and write your reviews.</p>
          <a className="btn btn-ink" href="/sign-in">
            Sign in
          </a>
        </ClientGate>
      </SitePage>
    );
  }
  if (view.status === "denied") {
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Your reviews">
          <Alert tone="warning" title="Not available" role="status">
            This account cannot write client reviews.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "review.view_unavailable", {
      route: "/client/reviews",
      outcome: view.status,
    });
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Your reviews">
          <Alert tone="error" title="Something went wrong" role="alert">
            Your reviews could not be shown right now. Please try again later.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  return (
    <SitePage session={shell.session} signOut={signOut}>
      <ClientAccount area="consultations" heading="Your reviews">
        <a className="link sm" href="/client/consultations">
          ← My consultations
        </a>
        <div className="cx-tools l-mt14">
          <p className="xs subtle l-mw640">{REVIEW_NOTE}</p>
          <span className="cx-note">{TIMES_IN_UTC}</span>
        </div>
        {view.consultations.length === 0 ? (
          <section
            className="cx-card l-mt18-p40-28-dflex-fdcolumn-aicente-8ccc4d"
            aria-labelledby="reviews-empty-h"
          >
            <h2 className="h4" id="reviews-empty-h">
              No consultation to review
            </h2>
            <p className="sm muted l-mt4-mw460">
              You have no completed consultation to review.
            </p>
          </section>
        ) : (
          view.consultations.map((entry) => (
            <section
              key={entry.consultationId}
              className="cx-card l-mt12-p22-24 rz-cx-panel"
              aria-labelledby={`review-${entry.consultationId}`}
            >
              <div className="row between l-g12-fwrwrap-aiflex-start">
                <div className="stack l-g2-minw0">
                  <h2 className="h4" id={`review-${entry.consultationId}`}>
                    {`Consultation ended ${dateText(entry.endedAt)}`}
                  </h2>
                  <p className="xs subtle">{whenText(entry.endedAt)}</p>
                </div>
                {entry.review === null ? null : (
                  <ClientPill
                    tone={REVIEW_STATE_LABELS[entry.review.state].tone}
                  >
                    {REVIEW_STATE_LABELS[entry.review.state].label}
                  </ClientPill>
                )}
              </div>
              <a
                className="cx-link"
                href={`/client/consultations/${entry.consultationId}`}
              >
                Open the consultation
              </a>
              <ReviewForm
                consultationId={entry.consultationId}
                reviewed={entry.review !== null}
              />
              {entry.review === null ? null : (
                <div className="stack l-g4">
                  <p className="sm">{`Rating: ${RATING_LABELS[entry.review.rating]}`}</p>
                  {entry.review.text === null ? null : (
                    <p className="cx-quote">{entry.review.text}</p>
                  )}
                  <p className="xs subtle">
                    {`Submitted ${whenText(entry.review.submittedAt)}`}
                  </p>
                </div>
              )}
            </section>
          ))
        )}
      </ClientAccount>
    </SitePage>
  );
}
