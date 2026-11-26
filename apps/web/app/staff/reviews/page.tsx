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
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Support): the design's
// status tabs above one card per review (the rating, the state pill, the
// text, its instants and the moderation form), then the pager.

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
  Empty,
  Note,
  PagerRow,
  Pill,
  TabLinks,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { refusalPage, StaffFrame } from "../frame.tsx";
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
    <StaffFrame
      title="Support"
      description="Client reviews: read, publish or reject submitted reviews."
      lead={
        <p>
          Reviews come from clients of completed consultations. Publish a review
          only after reading it; a published review can be taken down. Nothing
          is published automatically.
        </p>
      }
      utc
    >
      <TabLinks
        label="Reviews by state"
        links={REVIEW_STATES.map((entry) => ({
          href: `/staff/reviews?state=${entry}`,
          label: REVIEW_STATE_LABELS[entry].label,
        }))}
        current={base}
      />
      {view.reviews.length === 0 ? (
        <section className="st-listbox" aria-label="Reviews">
          <Empty
            title={
              view.pager.page === 1
                ? "There are no reviews in this list."
                : "There are no reviews on this page."
            }
          />
        </section>
      ) : (
        view.reviews.map((review) => (
          <section
            key={review.id}
            className="w-card st-panel"
            aria-labelledby={`queued-${review.id}`}
          >
            <div className="st-ptop">
              <h2 className="st-h2" id={`queued-${review.id}`}>
                {`Rating: ${RATING_LABELS[review.rating]}`}
              </h2>
              <span className="grow"></span>
              <Pill tone={REVIEW_STATE_LABELS[review.state].tone}>
                {REVIEW_STATE_LABELS[review.state].label}
              </Pill>
            </div>
            {review.text === null ? (
              <p className="st-emd">No text.</p>
            ) : (
              <Note>{review.text}</Note>
            )}
            <p className="st-emd">
              {`Submitted ${utcText(review.submittedAt)}${review.publishedAt === null ? "" : `; published ${utcText(review.publishedAt)}`}`}
            </p>
            <ModerationForm review={review.id} state={review.state} />
          </section>
        ))
      )}
      {view.pager.page === 1 && !view.pager.hasNext ? null : (
        <PagerRow
          note={`Page ${view.pager.page} of this list.`}
          previous={
            view.pager.page > 1 ? `${base}&page=${view.pager.page - 1}` : null
          }
          next={
            view.pager.hasNext ? `${base}&page=${view.pager.page + 1}` : null
          }
        />
      )}
    </StaffFrame>
  );
}
