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
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Support › Complaints): the
// design's status tabs and list, one row per case opening its own page.

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
  Cell,
  Empty,
  ListBox,
  ListRow,
  PagerRow,
  PillCell,
  TabLinks,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { refusalPage, StaffFrame } from "../frame.tsx";

export const metadata: Metadata = {
  title: "Reported problems",
  robots: { index: false, follow: false },
};

const COLUMNS = ["Reported (UTC)", "Assignment", "Status"] as const;

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
    <StaffFrame
      title="Support"
      description="Reported problems: concerns clients and attorneys report about a consultation."
      lead={
        <p>
          A reported problem is a restricted record. Opening one changes nothing
          about the consultation or its payment.
        </p>
      }
      utc
    >
      <TabLinks
        label="Reported problems by state"
        links={COMPLAINT_STATES.map((entry) => ({
          href: `/staff/complaints?state=${entry}`,
          label: COMPLAINT_STATE_LABELS[entry].label,
        }))}
        current={base}
      />
      <ListBox label="Reported problems" columns={COLUMNS} sub>
        {view.cases.length === 0 ? (
          <Empty
            title={
              view.pager.page === 1
                ? "There are no reported problems in this list."
                : "There are no reported problems on this page."
            }
          />
        ) : (
          view.cases.map((entry) => (
            <ListRow
              key={entry.id}
              href={`/staff/complaints/${entry.id}`}
              columns={3}
              sub
            >
              <Cell label="Reported" strong>
                {`Reported ${utcText(entry.openedAt)}`}
              </Cell>
              <Cell label="">
                {entry.consultationId === null
                  ? "Not about a consultation"
                  : "About a consultation"}
              </Cell>
              <Cell label="Assignment">
                {entry.assignedToMe ? "Assigned to you" : "Not assigned to you"}
              </Cell>
              <PillCell
                label="Status"
                tone={COMPLAINT_STATE_LABELS[entry.state].tone}
              >
                {COMPLAINT_STATE_LABELS[entry.state].label}
              </PillCell>
            </ListRow>
          ))
        )}
      </ListBox>
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
