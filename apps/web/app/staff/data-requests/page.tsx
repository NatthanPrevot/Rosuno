// Data requests (MVP-001 S11; PS-A6 section 3; MBS section 18.4 "privacy /
// data requests").
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs the global manage_data_requests grant (the
// database decides again). The requests in one state are listed one page at
// a time with their type, times, decision and whether they are assigned to
// the caller; never the client's description (that is on the request's own
// page). The two query values read, state and page, only choose the list and
// the page.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Administration › Settings,
// privacy requests): the design's state tabs and list, one row per request
// opening its record, then the pager.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  REQUEST_STATES,
  resolveDataRequestQueue,
  staffDataRequestPathFor,
} from "../../../src/application/data-requests.ts";
import { STAFF_DATA_REQUEST_SOURCES } from "../../../src/infrastructure/privacy/privacy-adapter.ts";
import { utcText } from "../../../src/presentation/completion-labels.ts";
import {
  DATA_REQUEST_STAFF_NOTE,
  OUTCOME_LABELS,
  REQUEST_STATE_LABELS,
  STAFF_REQUEST_TYPE_LABELS,
} from "../../../src/presentation/privacy-labels.ts";
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
  title: "Data requests",
  robots: { index: false, follow: false },
};

const COLUMNS = ["Request", "Assignment", "Decision", "Status"] as const;

export default async function DataRequestsPage({
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
  const view = await resolveDataRequestQueue(
    STAFF_DATA_REQUEST_SOURCES,
    state,
    page,
  );
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/data-requests", "Data requests");
  }
  const base = `/staff/data-requests?state=${view.requestState}`;
  return (
    <StaffFrame
      title="Settings"
      subtitle="Privacy requests: the data requests clients submit."
      lead={<p>{DATA_REQUEST_STAFF_NOTE}</p>}
      utc
    >
      <TabLinks
        label="Privacy requests by state"
        links={REQUEST_STATES.map((entry) => ({
          href: `/staff/data-requests?state=${entry}`,
          label: REQUEST_STATE_LABELS[entry].label,
        }))}
        current={base}
      />
      <ListBox
        label={REQUEST_STATE_LABELS[view.requestState].label}
        columns={COLUMNS}
        sub
      >
        {view.requests.length === 0 ? (
          <Empty
            title={
              view.pager.page === 1
                ? "There are no data requests in this list."
                : "There are no data requests on this page."
            }
          />
        ) : (
          view.requests.map((request) => (
            <ListRow
              key={request.id}
              href={staffDataRequestPathFor(request.id)}
              columns={4}
              sub
            >
              <Cell label="Request" strong>
                {STAFF_REQUEST_TYPE_LABELS[request.type]}
              </Cell>
              <Cell label="">{`Submitted ${utcText(request.submittedAt)}`}</Cell>
              <Cell label="Assignment">
                {request.assignedToMe
                  ? "Assigned to you"
                  : "Not assigned to you"}
              </Cell>
              <Cell label="Decision">
                {request.outcome === null
                  ? "None recorded"
                  : OUTCOME_LABELS[request.outcome]}
              </Cell>
              <PillCell
                label="Status"
                tone={REQUEST_STATE_LABELS[request.state].tone}
              >
                {REQUEST_STATE_LABELS[request.state].label}
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
