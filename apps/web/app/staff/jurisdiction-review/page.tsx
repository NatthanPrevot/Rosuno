// Jurisdiction assessment review (MVP-001 S3 part 2; MBS section 8; PS
// section 12.2).
//
// Rendered on the server for every request. A fresh staff identity and the
// database's own capability predicate decide access: the view needs the
// manage_intake_configuration capability in some scope at aal2 (the
// authority names no other capability for this review), and the database's
// own read functions show only the assessments of jurisdictions the grant
// covers. One group is listed at a time, one page at a time: submitted or
// active Intakes holding an unreviewed assessment in the caller's scope,
// then (global grants only) those that name no jurisdiction. Each Intake is
// shown by its opaque id, state, creation time and how many jurisdictions it
// names (several stay several; none is chosen); each assessment by its
// jurisdiction, source, basis and review status. No client identity and no
// Intake content is shown. A review records only "confirmed: may be
// relevant" or "not confirmed", once, and never asserts governing law. The
// two query values read, group and page, only choose the group and the
// page; the server checks both.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Platform › Marketplace):
// the design's group tabs above one card per Intake, each named jurisdiction
// a bordered card with its source, basis, review state and the two decision
// forms while it is reviewable, then the pager.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  REVIEW_GROUPS,
  resolveJurisdictionReview,
} from "../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import {
  AMBIGUITY_LABELS,
  ASSESSMENT_SOURCE_LABELS,
  ASSESSMENT_STATUS_LABELS,
  REVIEW_GROUP_LINKS,
  REVIEW_NOTE,
  utcDateTime,
} from "../../../src/presentation/staff-configuration-labels.ts";
import {
  Empty,
  KeyValues,
  Pill,
  TabLinks,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { PagerLinks, refusalPage, StaffFrame } from "../frame.tsx";
import { ReviewAssessmentForms } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Jurisdiction assessment review",
  robots: { index: false, follow: false },
};

const EMPTY_GROUP = Object.freeze({
  unreviewed: "No assessment waits for your review.",
  unnamed: "No submitted Intake is without a named jurisdiction.",
});

export default async function JurisdictionReviewPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly group?: string | string[];
    readonly page?: string | string[];
  }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { group, page } = await searchParams;
  const view = await resolveJurisdictionReview(
    STAFF_CONFIGURATION_SOURCES,
    group,
    page,
  );
  if (view.status !== "ready") {
    return refusalPage(
      view,
      "/staff/jurisdiction-review",
      "Jurisdiction assessment review",
    );
  }
  const current = REVIEW_GROUP_LINKS[view.group];
  return (
    <StaffFrame
      title="Marketplace"
      subtitle="Jurisdiction review: the jurisdictions submitted Intakes name, as suggestions."
      lead={<p>{REVIEW_NOTE}</p>}
      utc
    >
      <TabLinks
        label="Intakes by group"
        links={REVIEW_GROUPS.filter(
          (option) => option === "unreviewed" || view.global,
        ).map((option) => ({
          href: REVIEW_GROUP_LINKS[option].href,
          label: REVIEW_GROUP_LINKS[option].title,
        }))}
        current={current.href}
      />
      {view.intakes.length === 0 ? (
        <section className="st-listbox" aria-label="Intakes">
          <Empty
            title={
              view.pager.page === 1
                ? EMPTY_GROUP[view.group]
                : "There are no Intakes on this page."
            }
          />
        </section>
      ) : null}
      {view.intakes.map((intake) => (
        <section
          key={intake.intakeId}
          className="w-card st-panel"
          aria-labelledby={`intake-${intake.intakeId}`}
        >
          <div className="st-ptop">
            <h2 className="st-h2" id={`intake-${intake.intakeId}`}>
              {`Intake ${intake.intakeId}`}
            </h2>
            <span className="grow"></span>
            <Pill tone={AMBIGUITY_LABELS[intake.ambiguity].tone}>
              {AMBIGUITY_LABELS[intake.ambiguity].label}
            </Pill>
          </div>
          <p className="st-emd">
            {`${intake.state === "active" ? "Active" : "Submitted"}; started ${utcDateTime(intake.createdAt)}`}
          </p>
          {intake.assessments.length === 0 ? (
            <p className="st-note">
              The client named no jurisdiction. Nothing is chosen for them, and
              there is nothing to review.
            </p>
          ) : (
            intake.assessments.map((assessment) => (
              <div key={assessment.id} className="st-subcard">
                <div className="st-ptop">
                  <h3 className="st-h2s">{assessment.jurisdiction}</h3>
                  <span className="grow"></span>
                  <Pill tone={ASSESSMENT_STATUS_LABELS[assessment.status].tone}>
                    {ASSESSMENT_STATUS_LABELS[assessment.status].label}
                  </Pill>
                </div>
                <KeyValues
                  items={[
                    ["Source", ASSESSMENT_SOURCE_LABELS[assessment.source]],
                    ["Basis", assessment.basis],
                    ...(assessment.reviewedAt === null
                      ? []
                      : ([
                          [
                            "Review",
                            `By ${assessment.reviewedBy ?? "staff"} at ${utcDateTime(assessment.reviewedAt)}`,
                          ],
                        ] as const)),
                  ]}
                />
                {assessment.reviewable ? (
                  <ReviewAssessmentForms assessment={assessment.id} />
                ) : null}
              </div>
            ))
          )}
        </section>
      ))}
      <PagerLinks
        pager={view.pager}
        base={current.href}
        noun="Intakes"
        shown={view.intakes.length}
      />
    </StaffFrame>
  );
}
