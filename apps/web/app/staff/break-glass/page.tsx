// Break-glass access (MVP-001 S11; PS-A6 section 2; MBS section 5; TA
// section 20).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs an active Staff Profile (the database decides
// again). Every active staff member may request read-only access to one
// Consultation with a reason and sees their own requests and grants with the
// state the database derives now (requested, active, expired, revoked); an
// active grant links to its read-only view. Holders of approve_break_glass
// also see, one page at a time, the grants in their scope in one state, and
// approve a request (with a duration they choose; never their own) or revoke
// a request or an active access. The two query values read, state and page,
// only choose the list and the page.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  breakGlassPathFor,
  GRANT_STATES,
  resolveBreakGlassWorkspace,
  type OwnGrant,
} from "../../../src/application/break-glass.ts";
import { BREAK_GLASS_SOURCES } from "../../../src/infrastructure/privacy/privacy-adapter.ts";
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
  BREAK_GLASS_NOTE,
  GRANT_STATE_LABELS,
} from "../../../src/presentation/privacy-labels.ts";
import { requireSteppedUp } from "../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../frame.tsx";
import {
  ApproveAccessForm,
  RequestAccessForm,
  RevokeAccessForm,
} from "./forms.tsx";

export const metadata: Metadata = {
  title: "Break-glass access",
  robots: { index: false, follow: false },
};

function timesOf(grant: OwnGrant): string {
  return [
    `Requested ${utcText(grant.requestedAt)}`,
    grant.approvedAt === null ? null : `approved ${utcText(grant.approvedAt)}`,
    grant.expiresAt === null
      ? null
      : `${grant.state === "expired" ? "expired" : "expires"} ${utcText(grant.expiresAt)}`,
    grant.revokedAt === null ? null : `revoked ${utcText(grant.revokedAt)}`,
  ]
    .filter((part) => part !== null)
    .join("; ");
}

export default async function BreakGlassPage({
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
  const view = await resolveBreakGlassWorkspace(
    BREAK_GLASS_SOURCES,
    state,
    page,
  );
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/break-glass", "Break-glass access");
  }
  const queue = view.queue;
  const base =
    queue === null ? "" : `/staff/break-glass?state=${queue.grantState}`;
  return (
    <StaffFrame eyebrow="Security" title="Break-glass access">
      <BackLink href="/staff">Staff tools</BackLink>
      <Text tone="muted">{BREAK_GLASS_NOTE}</Text>
      <Heading as="h2" size="md" id="request-title">
        Request access
      </Heading>
      <RequestAccessForm />
      <Heading as="h2" size="md" id="mine-title">
        Your requests
      </Heading>
      {view.mine.length === 0 ? (
        <Text>You have not requested break-glass access.</Text>
      ) : (
        view.mine.map((grant) => (
          <Surface key={grant.id} labelledBy={`mine-${grant.id}`}>
            <Stack gap="tight">
              <Heading as="h3" size="sm" id={`mine-${grant.id}`}>
                {`Consultation ${grant.resourceId}`}
              </Heading>
              <Cluster>
                <Status tone={GRANT_STATE_LABELS[grant.state].tone}>
                  {GRANT_STATE_LABELS[grant.state].label}
                </Status>
              </Cluster>
              <Text size="small">{`Reason: ${grant.reason}`}</Text>
              <Text size="small" tone="muted">
                {timesOf(grant)}
              </Text>
              {grant.state === "active" ? (
                <Cluster>
                  <ButtonLink
                    variant="primary"
                    href={breakGlassPathFor(grant.id)}
                  >
                    Open the read-only view
                  </ButtonLink>
                </Cluster>
              ) : null}
            </Stack>
          </Surface>
        ))
      )}
      {queue === null ? null : (
        <>
          <Heading as="h2" size="md" id="queue-title">
            Requests and grants to decide on
          </Heading>
          <Cluster>
            {GRANT_STATES.map((entry) => (
              <ButtonLink
                key={entry}
                variant={entry === queue.grantState ? "primary" : "secondary"}
                href={`/staff/break-glass?state=${entry}`}
                aria-current={entry === queue.grantState ? "page" : undefined}
              >
                {GRANT_STATE_LABELS[entry].label}
              </ButtonLink>
            ))}
          </Cluster>
          {queue.grants.length === 0 ? (
            <Text>
              {queue.pager.page === 1
                ? "There is nothing in this list."
                : "There is nothing on this page."}
            </Text>
          ) : (
            queue.grants.map((grant) => (
              <Surface key={grant.id} labelledBy={`grant-${grant.id}`}>
                <Stack gap="tight">
                  <Heading as="h3" size="sm" id={`grant-${grant.id}`}>
                    {`Consultation ${grant.resourceId}`}
                  </Heading>
                  <Cluster>
                    <Status tone={GRANT_STATE_LABELS[grant.state].tone}>
                      {GRANT_STATE_LABELS[grant.state].label}
                    </Status>
                    {grant.requestedByMe ? (
                      <Status tone="neutral">Requested by you</Status>
                    ) : null}
                  </Cluster>
                  <Text size="small">{`Reason: ${grant.reason}`}</Text>
                  <Text size="small" tone="muted">
                    {timesOf(grant)}
                  </Text>
                  {grant.state === "requested" && !grant.requestedByMe ? (
                    <ApproveAccessForm grant={grant.id} />
                  ) : null}
                  {grant.state === "requested" ? (
                    <RevokeAccessForm
                      grant={grant.id}
                      label="Refuse the request"
                    />
                  ) : null}
                  {grant.state === "active" ? (
                    <RevokeAccessForm
                      grant={grant.id}
                      label="Revoke the access"
                    />
                  ) : null}
                </Stack>
              </Surface>
            ))
          )}
          <Cluster>
            {queue.pager.page > 1 ? (
              <ButtonLink
                variant="secondary"
                href={`${base}&page=${queue.pager.page - 1}`}
              >
                Previous page
              </ButtonLink>
            ) : null}
            {queue.pager.hasNext ? (
              <ButtonLink
                variant="secondary"
                href={`${base}&page=${queue.pager.page + 1}`}
              >
                Next page
              </ButtonLink>
            ) : null}
          </Cluster>
        </>
      )}
    </StaffFrame>
  );
}
