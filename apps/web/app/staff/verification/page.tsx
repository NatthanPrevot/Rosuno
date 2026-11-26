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
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Applications &
// verification): the design's list of the queue, one row per attorney
// opening the review, then the pager. The other staff tools are in the
// staff layout's navigation.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveStaffQueue } from "../../../src/application/staff-verification.ts";
import type { ProfileState } from "../../../src/application/professional-records.ts";
import { STAFF_VERIFICATION_SOURCES } from "../../../src/infrastructure/staff/staff-verification-adapter.ts";
import { Alert } from "../../../src/presentation/design-system.tsx";
import {
  Cell,
  DenyCard,
  Empty,
  Lead,
  ListBox,
  ListRow,
  PagerRow,
  PillCell,
  StaffBody,
  StaffHeader,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";

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

const TITLE_ID = "staff-verification-title";

const COLUMNS = [
  "Attorney",
  "License claims",
  "Pending practice-area requests",
  "Profile stage",
] as const;

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
  await requireSteppedUp("staff");
  const { page } = await searchParams;
  const view = await resolveStaffQueue(STAFF_VERIFICATION_SOURCES, page);
  if (view.status === "sign-in-required") {
    return (
      <>
        <StaffHeader titleId={TITLE_ID} title="Sign in to continue" />
        <StaffBody>
          <DenyCard
            pill="Signed out"
            tone="neutral"
            role="status"
            links={
              <a className="btn btn-ink btn-sm" href="/sign-in">
                Sign in
              </a>
            }
          >
            Verification review is available only to signed-in staff with the
            required access.
          </DenyCard>
        </StaffBody>
      </>
    );
  }
  if (view.status === "denied") {
    return (
      <>
        <StaffHeader
          titleId={TITLE_ID}
          title="Verification review not available"
        />
        <StaffBody>
          <DenyCard
            pill="No verification access"
            tone="warning"
            role="status"
            links={
              <a className="btn btn-line btn-sm" href="/staff">
                Other staff tools
              </a>
            }
          >
            This account does not hold current verification access. A staff
            profile alone grants none.
          </DenyCard>
        </StaffBody>
      </>
    );
  }
  if (view.status === "unavailable") {
    return (
      <>
        <StaffHeader
          titleId={TITLE_ID}
          title="Verification review unavailable"
        />
        <StaffBody>
          <DenyCard
            pill="Access could not be confirmed"
            tone="error"
            role="alert"
          >
            Verification review could not be opened right now. Please try again
            later.
          </DenyCard>
        </StaffBody>
      </>
    );
  }
  return (
    <>
      <StaffHeader
        titleId={TITLE_ID}
        title="Applications & verification"
        description="Attorney applications and professional records waiting for review."
      />
      <Lead>
        <p>{`Your current scope: ${view.scope.join(", ")}.`}</p>
      </Lead>
      <StaffBody>
        {view.global ? null : (
          <Alert tone="information" title="Jurisdiction-scoped access">
            Profile details and profile-stage changes need jurisdiction-free
            access. You can review the professional records in your
            jurisdictions.
          </Alert>
        )}
        <ListBox label="Applications and records in scope" columns={COLUMNS}>
          {view.entries.length === 0 && view.page === 1 ? (
            <Empty
              title="Nothing in your scope is waiting."
              note="An application appears here once it is submitted through the attorney application."
            />
          ) : null}
          {view.entries.length === 0 && view.page > 1 ? (
            <Empty
              title="There is nothing on this page of the queue."
              note={
                <a className="st-link" href="/staff/verification">
                  Show the first page
                </a>
              }
            />
          ) : null}
          {view.entries.map((entry) => (
            <ListRow
              key={entry.attorneyId}
              href={`/staff/verification/${entry.attorneyId}`}
              columns={4}
            >
              <Cell label="Attorney" strong>
                {entry.name}
              </Cell>
              <Cell label="License claims">{entry.licenseClaims}</Cell>
              <Cell label="Pending practice-area requests">
                {entry.pendingRequests}
              </Cell>
              {entry.stage === null ? (
                <PillCell label="Profile stage" tone="neutral">
                  Not in your scope
                </PillCell>
              ) : (
                <PillCell label="Profile stage" tone="neutral">
                  {STAGE_LABELS[entry.stage]}
                </PillCell>
              )}
            </ListRow>
          ))}
        </ListBox>
        {view.previousPage === null && view.nextPage === null ? null : (
          <PagerRow
            note={
              <>
                {`Page ${view.page} of the queue.`}
                {view.global
                  ? " Profiles are listed most recently changed first."
                  : " Attorneys are listed from your license claims and pending requests; an attorney whose records span pages appears on each, always with full counts."}
                {view.nextPage === null
                  ? " This is the last page."
                  : " More of the queue is on the next page."}
              </>
            }
            previous={
              view.previousPage === null ? null : pageHref(view.previousPage)
            }
            next={view.nextPage === null ? null : pageHref(view.nextPage)}
          />
        )}
      </StaffBody>
    </>
  );
}
