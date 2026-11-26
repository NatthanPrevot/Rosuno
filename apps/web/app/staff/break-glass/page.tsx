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
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Administration › Staff):
// the request form and the caller's own requests in the design's panels, then
// the approval queue's state tabs and one card per grant inside the one slot of
// the decision forms, and the pager.

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
  BREAK_GLASS_NOTE,
  BREAK_GLASS_STAFF_REQUIRED,
  GRANT_STATE_LABELS,
} from "../../../src/presentation/privacy-labels.ts";
import {
  DenyCard,
  Empty,
  KeyValues,
  PagerRow,
  Panel,
  Pill,
  TabLinks,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { refusalPage, StaffFrame } from "../frame.tsx";
import {
  ApproveAccessForm,
  GrantDecisions,
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
  if (view.status === "denied") {
    // The surface needs an active Staff Profile, not a capability.
    return (
      <StaffFrame title="Break-glass access not available">
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
          {BREAK_GLASS_STAFF_REQUIRED}
        </DenyCard>
      </StaffFrame>
    );
  }
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/break-glass", "Break-glass access");
  }
  const queue = view.queue;
  const base =
    queue === null ? "" : `/staff/break-glass?state=${queue.grantState}`;
  return (
    <StaffFrame
      title="Staff"
      subtitle="Break-glass access: time-limited, audited read access to one consultation."
      lead={<p>{BREAK_GLASS_NOTE}</p>}
      utc
    >
      <Panel id="request-title" title="Request access">
        <RequestAccessForm />
      </Panel>
      <Panel id="mine-title" title="Your requests">
        {view.mine.length === 0 ? (
          <Empty small title="You have not requested break-glass access." />
        ) : (
          view.mine.map((grant) => (
            <article
              key={grant.id}
              className="st-subcard"
              aria-labelledby={`mine-${grant.id}`}
            >
              <div className="st-ptop">
                <h3 className="st-h2s" id={`mine-${grant.id}`}>
                  {`Consultation ${grant.resourceId}`}
                </h3>
                <span className="grow"></span>
                <Pill tone={GRANT_STATE_LABELS[grant.state].tone}>
                  {GRANT_STATE_LABELS[grant.state].label}
                </Pill>
              </div>
              <KeyValues
                items={[
                  ["Reason", grant.reason],
                  ["Times", timesOf(grant)],
                ]}
              />
              {grant.state === "active" ? (
                <div className="st-links">
                  <a
                    className="btn btn-ink btn-sm"
                    href={breakGlassPathFor(grant.id)}
                  >
                    Open the read-only view
                  </a>
                </div>
              ) : null}
            </article>
          ))
        )}
      </Panel>
      {queue === null ? null : (
        <>
          <h2 className="st-h2" id="queue-title">
            Requests and grants to decide on
          </h2>
          <TabLinks
            label="Grants by state"
            links={GRANT_STATES.map((entry) => ({
              href: `/staff/break-glass?state=${entry}`,
              label: GRANT_STATE_LABELS[entry].label,
            }))}
            current={base}
          />
          <GrantDecisions>
            {queue.grants.length === 0 ? (
              <section className="st-listbox" aria-label="Grants">
                <Empty
                  title={
                    queue.pager.page === 1
                      ? "There is nothing in this list."
                      : "There is nothing on this page."
                  }
                />
              </section>
            ) : (
              queue.grants.map((grant) => (
                <section
                  key={grant.id}
                  className="w-card st-panel"
                  aria-labelledby={`grant-${grant.id}`}
                >
                  <div className="st-ptop">
                    <h3 className="st-h2" id={`grant-${grant.id}`}>
                      {`Consultation ${grant.resourceId}`}
                    </h3>
                    <span className="grow"></span>
                    {grant.requestedByMe ? (
                      <Pill tone="neutral">Requested by you</Pill>
                    ) : null}
                    <Pill tone={GRANT_STATE_LABELS[grant.state].tone}>
                      {GRANT_STATE_LABELS[grant.state].label}
                    </Pill>
                  </div>
                  <KeyValues
                    items={[
                      ["Reason", grant.reason],
                      ["Times", timesOf(grant)],
                    ]}
                  />
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
                </section>
              ))
            )}
          </GrantDecisions>
          {queue.pager.page === 1 && !queue.pager.hasNext ? null : (
            <PagerRow
              note={`Page ${queue.pager.page} of this list.`}
              previous={
                queue.pager.page > 1
                  ? `${base}&page=${queue.pager.page - 1}`
                  : null
              }
              next={
                queue.pager.hasNext
                  ? `${base}&page=${queue.pager.page + 1}`
                  : null
              }
            />
          )}
        </>
      )}
    </StaffFrame>
  );
}
