// Legal Holds (MVP-001 S11; PS section 26.2; TA sections 40 and 51; ROS
// section 16.3; PM row 48).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs the global manage_legal_holds grant (the database
// decides again). Holds in force, or released ones, are listed one page at a
// time with what they cover, the reason and when they started or were
// released. A hold can be placed on a Consultation, an Intake, a document or
// file, a reported problem or a User, and released once; each step is
// audited. The two query values read, status and page, only choose the list
// and the page.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  HOLD_STATUSES,
  resolveLegalHolds,
} from "../../../src/application/legal-holds.ts";
import { LEGAL_HOLD_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import {
  HOLD_SCOPE_LABELS,
  HOLD_STATUS_LABELS,
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
import { PlaceHoldForm, ReleaseHoldForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Legal Holds",
  robots: { index: false, follow: false },
};

export default async function LegalHoldsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly status?: string | string[];
    readonly page?: string | string[];
  }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { status, page } = await searchParams;
  const view = await resolveLegalHolds(LEGAL_HOLD_SOURCES, status, page);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/legal-holds", "Legal Holds");
  }
  const base = `/staff/legal-holds?status=${view.holdStatus}`;
  return (
    <StaffFrame eyebrow="Records" title="Legal Holds">
      <BackLink href="/staff">Staff tools</BackLink>
      <Heading as="h2" size="md" id="place-title">
        Place a Legal Hold
      </Heading>
      <PlaceHoldForm scope={null} />
      <Heading as="h2" size="md" id="holds-title">
        Legal Holds
      </Heading>
      <Cluster>
        {HOLD_STATUSES.map((entry) => (
          <ButtonLink
            key={entry}
            variant={entry === view.holdStatus ? "primary" : "secondary"}
            href={`/staff/legal-holds?status=${entry}`}
            aria-current={entry === view.holdStatus ? "page" : undefined}
          >
            {HOLD_STATUS_LABELS[entry]}
          </ButtonLink>
        ))}
      </Cluster>
      {view.holds.length === 0 ? (
        <Text>
          {view.pager.page === 1
            ? "There are no Legal Holds in this list."
            : "There are no Legal Holds on this page."}
        </Text>
      ) : (
        view.holds.map((hold) => (
          <Surface key={hold.id} labelledBy={`hold-${hold.id}`}>
            <Stack gap="tight">
              <Heading as="h3" size="sm" id={`hold-${hold.id}`}>
                {`${HOLD_SCOPE_LABELS[hold.scope]} ${hold.scopeId}`}
              </Heading>
              <Cluster>
                <Status tone={hold.status === "active" ? "warning" : "neutral"}>
                  {HOLD_STATUS_LABELS[hold.status]}
                </Status>
                {hold.placedByMe ? (
                  <Status tone="neutral">Placed by you</Status>
                ) : null}
              </Cluster>
              <Text size="small">{`Reason: ${hold.reason}`}</Text>
              <Text size="small" tone="muted">
                {`Started ${utcText(hold.startedAt)}${hold.releasedAt === null ? "" : `; released ${utcText(hold.releasedAt)}`}`}
              </Text>
              {hold.status === "active" ? (
                <ReleaseHoldForm hold={hold.id} />
              ) : null}
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
