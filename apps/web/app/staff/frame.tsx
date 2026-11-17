// Shared frame of the staff configuration pages (MVP-001 S1).
//
// Presentation only, rendered on the server. The pages decide access through
// the staff configuration use cases; this module only frames what they
// decided. A refused request sees one fixed message and no configuration
// data; an unavailable one also writes one log line naming the route, with
// nothing the request carried.

import type { ReactNode } from "react";

import type { Pager } from "../../src/application/staff-configuration.ts";
import { logRequestEvent } from "../../src/infrastructure/observability/request-log.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Eyebrow,
  Heading,
  Page,
  Stack,
  Surface,
  Text,
} from "../../src/presentation/design-system.tsx";

export function StaffFrame({
  eyebrow,
  title,
  children,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="admin">
      <Surface emphasis="raised" labelledBy="staff-configuration-title">
        <Stack>
          <Eyebrow>{eyebrow}</Eyebrow>
          <Heading as="h1" size="lg" id="staff-configuration-title">
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

export function BackLink({
  href,
  children,
}: {
  readonly href: string;
  readonly children: ReactNode;
}) {
  return (
    <Cluster>
      <ButtonLink variant="tertiary" href={href}>
        {children}
      </ButtonLink>
    </Cluster>
  );
}

// The address of one page of a list: the first page has no query.
export function pageHref(base: string, page: number): string {
  return page === 1 ? base : `${base}?page=${page}`;
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
    <>
      <Text tone="muted">
        {shown === 0
          ? `There are no ${noun} on page ${pager.page}.`
          : `Showing ${noun} ${first} to ${first + shown - 1}.`}
        {pager.nextPage === null
          ? ` There are no more ${noun}.`
          : ` More ${noun} are on the next page.`}
      </Text>
      <Cluster>
        {pager.previousPage === null ? null : (
          <ButtonLink
            variant="secondary"
            href={pageHref(base, pager.previousPage)}
          >
            Previous page
          </ButtonLink>
        )}
        {pager.nextPage === null ? null : (
          <ButtonLink variant="secondary" href={pageHref(base, pager.nextPage)}>
            Next page
          </ButtonLink>
        )}
      </Cluster>
    </>
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
      <StaffFrame eyebrow="Staff" title="Sign in to continue">
        <Text tone="muted">
          {`${surface} is available only to signed-in staff with the required capability.`}
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
      <StaffFrame eyebrow="Staff" title={`${surface} not available`}>
        <Alert tone="warning" title="No access" role="status">
          This account does not hold a current capability for this. A staff
          profile alone grants none.
        </Alert>
        <BackLink href="/staff">Staff tools</BackLink>
      </StaffFrame>
    );
  }
  await logRequestEvent("warn", "staff_configuration.view_unavailable", {
    route,
    outcome: "unavailable",
  });
  return (
    <StaffFrame eyebrow="Staff" title={`${surface} unavailable`}>
      <Alert tone="error" title="Could not be opened" role="alert">
        This could not be opened right now. Please try again later.
      </Alert>
    </StaffFrame>
  );
}
