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
  ButtonLink,
  Cluster,
  Heading,
  Stack,
  Status,
  Surface,
  Text,
} from "../../../src/presentation/design-system.tsx";
import {
  DATA_REQUEST_STAFF_NOTE,
  OUTCOME_LABELS,
  REQUEST_STATE_LABELS,
  STAFF_REQUEST_TYPE_LABELS,
} from "../../../src/presentation/privacy-labels.ts";
import { requireSteppedUp } from "../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../frame.tsx";

export const metadata: Metadata = {
  title: "Data requests",
  robots: { index: false, follow: false },
};

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
    <StaffFrame eyebrow="Clients" title="Data requests">
      <BackLink href="/staff">Staff tools</BackLink>
      <Text tone="muted">{DATA_REQUEST_STAFF_NOTE}</Text>
      <Cluster>
        {REQUEST_STATES.map((entry) => (
          <ButtonLink
            key={entry}
            variant={entry === view.requestState ? "primary" : "secondary"}
            href={`/staff/data-requests?state=${entry}`}
            aria-current={entry === view.requestState ? "page" : undefined}
          >
            {REQUEST_STATE_LABELS[entry].label}
          </ButtonLink>
        ))}
      </Cluster>
      <Heading as="h2" size="md" id="requests-title">
        {REQUEST_STATE_LABELS[view.requestState].label}
      </Heading>
      {view.requests.length === 0 ? (
        <Text>
          {view.pager.page === 1
            ? "There are no data requests in this list."
            : "There are no data requests on this page."}
        </Text>
      ) : (
        view.requests.map((request) => (
          <Surface key={request.id} labelledBy={`request-${request.id}`}>
            <Stack gap="tight">
              <Heading as="h3" size="sm" id={`request-${request.id}`}>
                {`${STAFF_REQUEST_TYPE_LABELS[request.type]}, submitted ${utcText(request.submittedAt)}`}
              </Heading>
              <Cluster>
                <Status tone={REQUEST_STATE_LABELS[request.state].tone}>
                  {REQUEST_STATE_LABELS[request.state].label}
                </Status>
                {request.assignedToMe ? (
                  <Status tone="neutral">Assigned to you</Status>
                ) : null}
                {request.outcome === null ? null : (
                  <Status tone="neutral">
                    {OUTCOME_LABELS[request.outcome]}
                  </Status>
                )}
              </Cluster>
              <Cluster>
                <ButtonLink
                  variant="secondary"
                  href={staffDataRequestPathFor(request.id)}
                >
                  Open the request
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
