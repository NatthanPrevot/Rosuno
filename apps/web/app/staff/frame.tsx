// Shared frame of the staff configuration pages (MVP-001 S1).
//
// Presentation only, rendered on the server. The pages decide access through
// the staff configuration use cases; this module only frames what they
// decided. A refused request sees one fixed message and no configuration
// data; an unavailable one also writes one log line naming the route, with
// nothing the request carried.
//
// DEV-001: the owner's UI/UX design (UIUX-HANDOFF-P2 build_p8, Staff.dc.html):
// the page header and body inside the staff workspace frame the staff layout
// draws, the design's "not permitted" card for a refused request, and its
// links and pager. The layout's navigation is presentation only; every page
// keeps its own access decision.

import type { ReactNode } from "react";

import type { Pager } from "../../src/application/staff-configuration.ts";
import { logRequestEvent } from "../../src/infrastructure/observability/request-log.ts";
import { Alert } from "../../src/presentation/design-system.tsx";
import {
  Lead,
  Pill,
  StaffBody,
  StaffHeader,
  TIMES_IN_UTC,
} from "../../src/presentation/staff-workspace.tsx";

export function StaffFrame({
  title,
  description,
  lead,
  utc = false,
  children,
}: {
  // The destination's name for the page (the design's page header) and its
  // one-line description.
  readonly title: string;
  readonly description?: string;
  // Plain context under the header (the design's lead).
  readonly lead?: ReactNode;
  // The page shows server instants, always in UTC.
  readonly utc?: boolean;
  // Accepted from pages not yet in the design's header; not shown.
  readonly eyebrow?: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      <StaffHeader
        titleId="staff-configuration-title"
        title={title}
        description={description}
        aside={utc ? TIMES_IN_UTC : undefined}
      />
      {lead === undefined ? null : <Lead>{lead}</Lead>}
      <StaffBody>{children}</StaffBody>
    </>
  );
}

// A link back to the list a page belongs to, in the design's link style.
export function BackLink({
  href,
  children,
}: {
  readonly href: string;
  readonly children: ReactNode;
}) {
  return (
    <p className="st-backrow">
      <a className="st-link st-back" href={href}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m15 6-6 6 6 6" />
        </svg>
        {children}
      </a>
    </p>
  );
}

// The address of one page of a list: the first page adds no page number. A
// base that already names a fixed query (MVP-001 S2: the job view's group)
// keeps it.
export function pageHref(base: string, page: number): string {
  return page === 1
    ? base
    : `${base}${base.includes("?") ? "&" : "?"}page=${page}`;
}

// The design's pager under a list: which page this is and links to its
// neighbours, so no row of a list is ever left out without the page saying
// so.
export function PagerRow({
  note,
  previous,
  next,
}: {
  readonly note: ReactNode;
  readonly previous: string | null;
  readonly next: string | null;
}) {
  return (
    <div className="st-pager">
      <p className="st-emd">{note}</p>
      {previous === null && next === null ? null : (
        <div className="st-links">
          {previous === null ? null : (
            <a className="btn btn-line btn-sm" href={previous}>
              Previous page
            </a>
          )}
          {next === null ? null : (
            <a className="btn btn-line btn-sm" href={next}>
              Next page
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// Says which page this is and links to its neighbours, so no row of a list
// is ever left out without the page saying so.
export function PagerLinks({
  pager,
  base,
  noun,
  shown,
}: {
  readonly pager: Pager;
  readonly base: string;
  readonly noun: string;
  readonly shown: number;
}) {
  if (pager.previousPage === null && pager.nextPage === null) {
    return null;
  }
  const first = (pager.page - 1) * pager.pageSize + 1;
  return (
    <PagerRow
      note={
        <>
          {shown === 0
            ? `There are no ${noun} on page ${pager.page}.`
            : `Showing ${noun} ${first} to ${first + shown - 1}.`}
          {pager.nextPage === null
            ? ` There are no more ${noun}.`
            : ` More ${noun} are on the next page.`}
        </>
      }
      previous={
        pager.previousPage === null ? null : pageHref(base, pager.previousPage)
      }
      next={pager.nextPage === null ? null : pageHref(base, pager.nextPage)}
    />
  );
}

// Says that a list read within its bound reached it, so not every row is
// shown.
export function BoundNotice({
  complete,
  noun,
}: {
  readonly complete: boolean;
  readonly noun: string;
}) {
  return complete ? null : (
    <Alert tone="warning" title="Not every entry is shown" role="status">
      {`There are more ${noun} than this page can list. Only the first are shown; nothing is changed by that.`}
    </Alert>
  );
}

// The design's card for a page that is not shown: its pill, the fixed
// message and, where the design has them, links onward.
export function DenyCard({
  pill,
  tone,
  role,
  children,
  links,
}: {
  readonly pill: string;
  readonly tone: "warning" | "error" | "neutral";
  readonly role: "status" | "alert";
  readonly children: ReactNode;
  readonly links?: ReactNode;
}) {
  return (
    <section className="w-card st-deny" role={role}>
      <Pill tone={tone}>{pill}</Pill>
      <p className="st-emd">{children}</p>
      {links === undefined ? null : <div className="st-links">{links}</div>}
    </section>
  );
}

type Refused = {
  readonly status: "sign-in-required" | "denied" | "unavailable";
};

// The fixed page for a refused request. An unavailable page writes one log
// line naming the route and the outcome.
export async function refusalPage(
  view: Refused,
  route: string,
  surface: string,
): Promise<ReactNode> {
  if (view.status === "sign-in-required") {
    return (
      <StaffFrame title="Sign in to continue">
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
          {`${surface} is available only to signed-in staff with the required capability.`}
        </DenyCard>
      </StaffFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <StaffFrame title={`${surface} not available`}>
        <DenyCard
          pill="No access"
          tone="warning"
          role="status"
          links={
            <a className="btn btn-line btn-sm" href="/staff">
              Go to Dashboard
            </a>
          }
        >
          This account does not hold a current capability for this. A staff
          profile alone grants none.
        </DenyCard>
      </StaffFrame>
    );
  }
  await logRequestEvent("warn", "staff_configuration.view_unavailable", {
    route,
    outcome: "unavailable",
  });
  return (
    <StaffFrame title={`${surface} unavailable`}>
      <DenyCard pill="Could not be opened" tone="error" role="alert">
        This could not be opened right now. Please try again later.
      </DenyCard>
    </StaffFrame>
  );
}
