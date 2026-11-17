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

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  REVIEW_GROUPS,
  resolveJurisdictionReview,
} from "../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import {
  ButtonLink,
  Cluster,
  Heading,
  Stack,
  Status,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import {
  AMBIGUITY_LABELS,
  ASSESSMENT_SOURCE_LABELS,
  ASSESSMENT_STATUS_LABELS,
  REVIEW_GROUP_LINKS,
  REVIEW_NOTE,
  utcDateTime,
} from "../../../src/presentation/staff-configuration-labels.ts";
import { requireSteppedUp } from "../../account/gate.ts";
import { BackLink, PagerLinks, refusalPage, StaffFrame } from "../frame.tsx";
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
    <StaffFrame eyebrow="Staff" title="Jurisdiction assessment review">
      <BackLink href="/staff">Staff tools</BackLink>
      <Text tone="muted">{REVIEW_NOTE}</Text>
      <Cluster>
        {REVIEW_GROUPS.filter(
          (option) => option === "unreviewed" || view.global,
        ).map((option) => (
          <ButtonLink
            key={option}
            variant={option === view.group ? "primary" : "secondary"}
            href={REVIEW_GROUP_LINKS[option].href}
            aria-current={option === view.group ? "page" : undefined}
          >
            {REVIEW_GROUP_LINKS[option].title}
          </ButtonLink>
        ))}
      </Cluster>
      {view.intakes.length === 0 ? (
        <Text>
          {view.pager.page === 1
            ? EMPTY_GROUP[view.group]
            : "There are no Intakes on this page."}
        </Text>
      ) : null}
      {view.intakes.map((intake) => (
        <Stack key={intake.intakeId}>
          <Heading as="h2" size="sm">
            {`Intake ${intake.intakeId}`}
          </Heading>
          <Cluster>
            <Status tone={AMBIGUITY_LABELS[intake.ambiguity].tone}>
              {AMBIGUITY_LABELS[intake.ambiguity].label}
            </Status>
            <Text tone="muted">
              {`${intake.state === "active" ? "Active" : "Submitted"}; started ${utcDateTime(intake.createdAt)}`}
            </Text>
          </Cluster>
          {intake.assessments.length === 0 ? (
            <Text tone="muted">
              The client named no jurisdiction. Nothing is chosen for them, and
              there is nothing to review.
            </Text>
          ) : (
            <Table
              id={`assessments-${intake.intakeId}`}
              caption="Jurisdictions this Intake names, as suggestions"
            >
              <thead>
                <tr>
                  <th scope="col">Jurisdiction</th>
                  <th scope="col">Source</th>
                  <th scope="col">Basis</th>
                  <th scope="col">Review</th>
                  <th scope="col">Decision</th>
                </tr>
              </thead>
              <tbody>
                {intake.assessments.map((assessment) => (
                  <tr key={assessment.id}>
                    <td>{assessment.jurisdiction}</td>
                    <td>{ASSESSMENT_SOURCE_LABELS[assessment.source]}</td>
                    <td>{assessment.basis}</td>
                    <td>
                      <Stack gap="tight">
                        <Status
                          tone={
                            ASSESSMENT_STATUS_LABELS[assessment.status].tone
                          }
                        >
                          {ASSESSMENT_STATUS_LABELS[assessment.status].label}
                        </Status>
                        {assessment.reviewedAt === null ? null : (
                          <Text size="small" tone="muted">
                            {`By ${assessment.reviewedBy ?? "staff"} at ${utcDateTime(assessment.reviewedAt)}`}
                          </Text>
                        )}
                      </Stack>
                    </td>
                    <td>
                      {assessment.reviewable ? (
                        <ReviewAssessmentForms assessment={assessment.id} />
                      ) : (
                        "None"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Stack>
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
