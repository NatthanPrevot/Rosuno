// Reported problems: the complaint queue (MVP-001 S11; MBS section 16
// "Complaint foundation"; PS sections 27.1 and 30.4; TA section 41).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs manage_complaints in some scope, and the database
// lists only the cases in the jurisdictions the caller holds it for (a case
// without a jurisdiction needs a global grant), one state at a time, oldest
// first, with the minimum metadata: state, linkage, instants and whether the
// case is assigned to the caller. The two query values read, state and page,
// only choose the list and the page.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  COMPLAINT_STATES,
  resolveComplaintQueue,
} from "../../../src/application/complaints.ts";
import { STAFF_COMPLAINT_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import {
  COMPLAINT_STATE_LABELS,
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

export const metadata: Metadata = {
  title: "Reported problems",
  robots: { index: false, follow: false },
};

export default async function ComplaintQueuePage({
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
  const view = await resolveComplaintQueue(
    STAFF_COMPLAINT_SOURCES,
    state,
    page,
  );
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/complaints", "Reported problems");
  }
  const base = `/staff/complaints?state=${view.complaintState}`;
  return (
    <StaffFrame eyebrow="Complaints" title="Reported problems">
      <BackLink href="/staff">Staff tools</BackLink>
      <Text tone="muted">
        A reported problem is a restricted record. Opening one changes nothing
        about the consultation or its payment.
      </Text>
      <Cluster>
        {COMPLAINT_STATES.map((entry) => (
          <ButtonLink
            key={entry}
            variant={entry === view.complaintState ? "primary" : "secondary"}
            href={`/staff/complaints?state=${entry}`}
            aria-current={entry === view.complaintState ? "page" : undefined}
          >
            {COMPLAINT_STATE_LABELS[entry].label}
          </ButtonLink>
        ))}
      </Cluster>
      {view.cases.length === 0 ? (
        <Text>
          {view.pager.page === 1
            ? "There are no reported problems in this list."
            : "There are no reported problems on this page."}
        </Text>
      ) : (
        view.cases.map((entry) => (
          <Surface key={entry.id} labelledBy={`case-${entry.id}`}>
            <Stack gap="tight">
              <Heading as="h2" size="sm" id={`case-${entry.id}`}>
                {`Reported ${utcText(entry.openedAt)}`}
              </Heading>
              <Cluster>
                <Status tone={COMPLAINT_STATE_LABELS[entry.state].tone}>
                  {COMPLAINT_STATE_LABELS[entry.state].label}
                </Status>
                {entry.assignedToMe ? (
                  <Status tone="neutral">Assigned to you</Status>
                ) : null}
                {entry.consultationId === null ? null : (
                  <Status tone="neutral">About a consultation</Status>
                )}
              </Cluster>
              <Cluster>
                <ButtonLink
                  variant="tertiary"
                  href={`/staff/complaints/${entry.id}`}
                >
                  Open the case
                </ButtonLink>
              </Cluster>
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
