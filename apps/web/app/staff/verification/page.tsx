// Staff verification queue (P3-003).
//
// Rendered on the server for every request. A fresh Staff identity and the
// database's own verification scope predicate decide access; the queue lists
// only what the reviewer's own session may read under the row policies, and
// never the reviewer's own attorney profile. MVP-001 D-4: the queue is shown
// one page at a time, at any size. The one query value read, page, only asks
// which page to show; the server checks it and shows the first page for
// anything else. When a page does not hold the whole queue, it says so and
// links to its neighbours, so nothing in scope is left out unseen. The page
// reads no route parameter, header, or cookie of its own and offers no
// change.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveStaffQueue } from "../../../src/application/staff-verification.ts";
import type { ProfileState } from "../../../src/application/professional-records.ts";
import { STAFF_VERIFICATION_SOURCES } from "../../../src/infrastructure/staff/staff-verification-adapter.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Eyebrow,
  Heading,
  Page,
  Stack,
  Status,
  Surface,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";

export const metadata: Metadata = {
  title: "Verification review",
  robots: { index: false, follow: false },
};

const STAGE_LABELS: Readonly<Record<ProfileState, string>> = {
  applicant: "Applicant (editing)",
  under_review: "Under review",
  approved: "Approved (stage only)",
  suspended: "Suspended",
  removed: "Removed",
};

function StaffFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="admin">
      <Surface emphasis="raised" labelledBy="staff-verification-title">
        <Stack>
          <Eyebrow>Staff verification</Eyebrow>
          <Heading as="h1" size="lg" id="staff-verification-title">
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

function pageHref(page: number): string {
  return page === 1
    ? "/staff/verification"
    : `/staff/verification?page=${page}`;
}

export default async function StaffVerificationQueuePage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string | string[] }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const { page } = await searchParams;
  const view = await resolveStaffQueue(STAFF_VERIFICATION_SOURCES, page);
  if (view.status === "sign-in-required") {
    return (
      <StaffFrame title="Sign in to continue">
        <Text tone="muted">
          Verification review is available only to signed-in staff with the
          required access.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </StaffFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <StaffFrame title="Verification review not available">
        <Alert tone="warning" title="No verification access" role="status">
          This account does not hold current verification access. A staff
          profile alone grants none.
        </Alert>
        <Cluster>
          <ButtonLink variant="tertiary" href="/staff">
            Other staff tools
          </ButtonLink>
        </Cluster>
      </StaffFrame>
    );
  }
  if (view.status === "unavailable") {
    return (
      <StaffFrame title="Verification review unavailable">
        <Alert tone="error" title="Access could not be confirmed" role="alert">
          Verification review could not be opened right now. Please try again
          later.
        </Alert>
      </StaffFrame>
    );
  }
  return (
    <StaffFrame title="Verification review queue">
      <Text tone="muted">
        {`Your current scope: ${view.scope.join(", ")}.`}
      </Text>
      {view.global ? null : (
        <Alert tone="information" title="Jurisdiction-scoped access">
          Profile details and profile-stage changes need jurisdiction-free
          access. You can review the professional records in your jurisdictions.
        </Alert>
      )}
      {view.entries.length === 0 && view.page === 1 ? (
        <Text tone="muted">Nothing in your scope is waiting.</Text>
      ) : null}
      {view.entries.length === 0 && view.page > 1 ? (
        <>
          <Text>There is nothing on this page of the queue.</Text>
          <Cluster>
            <ButtonLink variant="secondary" href="/staff/verification">
              Show the first page
            </ButtonLink>
          </Cluster>
        </>
      ) : null}
      {view.entries.length === 0 ? null : (
        <Table
          id="verification-queue"
          caption="Applications and records in scope"
        >
          <thead>
            <tr>
              <th scope="col">Attorney</th>
              <th scope="col">Profile stage</th>
              <th scope="col">License claims</th>
              <th scope="col">Pending practice-area requests</th>
              <th scope="col">Review</th>
            </tr>
          </thead>
          <tbody>
            {view.entries.map((entry) => (
              <tr key={entry.attorneyId}>
                <td>{entry.name}</td>
                <td>
                  {entry.stage === null ? (
                    "Not in your scope"
                  ) : (
                    <Status tone="neutral">{STAGE_LABELS[entry.stage]}</Status>
                  )}
                </td>
                <td>{entry.licenseClaims}</td>
                <td>{entry.pendingRequests}</td>
                <td>
                  <ButtonLink
                    variant="tertiary"
                    href={`/staff/verification/${entry.attorneyId}`}
                  >
                    Open review
                  </ButtonLink>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {view.previousPage === null && view.nextPage === null ? null : (
        <>
          <Text tone="muted">
            {`Page ${view.page} of the queue.`}
            {view.global
              ? " Profiles are listed most recently changed first."
              : " Attorneys are listed from your license claims and pending requests; an attorney whose records span pages appears on each, always with full counts."}
            {view.nextPage === null
              ? " This is the last page."
              : " More of the queue is on the next page."}
          </Text>
          <Cluster>
            {view.previousPage === null ? null : (
              <ButtonLink
                variant="secondary"
                href={pageHref(view.previousPage)}
              >
                Previous page
              </ButtonLink>
            )}
            {view.nextPage === null ? null : (
              <ButtonLink variant="secondary" href={pageHref(view.nextPage)}>
                Next page
              </ButtonLink>
            )}
          </Cluster>
        </>
      )}
      <Cluster>
        <ButtonLink variant="tertiary" href="/staff">
          Other staff tools
        </ButtonLink>
      </Cluster>
    </StaffFrame>
  );
}
