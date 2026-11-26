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
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Administration ›
// Settings): the placing form in the design's panel, then the status tabs and
// one card per hold with its release form, and the pager.

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
  Empty,
  KeyValues,
  PagerRow,
  Panel,
  Pill,
  TabLinks,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { refusalPage, StaffFrame } from "../frame.tsx";
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
    <StaffFrame
      title="Settings"
      subtitle="Legal holds: place and release them, and see which are in force."
      utc
    >
      <Panel id="place-title" title="Place a Legal Hold">
        <PlaceHoldForm scope={null} />
      </Panel>
      <h2 className="st-h2" id="holds-title">
        Legal Holds
      </h2>
      <TabLinks
        label="Legal Holds by status"
        links={HOLD_STATUSES.map((entry) => ({
          href: `/staff/legal-holds?status=${entry}`,
          label: HOLD_STATUS_LABELS[entry],
        }))}
        current={base}
      />
      {view.holds.length === 0 ? (
        <section className="st-listbox" aria-label="Legal Holds">
          <Empty
            title={
              view.pager.page === 1
                ? "There are no Legal Holds in this list."
                : "There are no Legal Holds on this page."
            }
          />
        </section>
      ) : (
        view.holds.map((hold) => (
          <section
            key={hold.id}
            className="w-card st-panel"
            aria-labelledby={`hold-${hold.id}`}
          >
            <div className="st-ptop">
              <h3 className="st-h2" id={`hold-${hold.id}`}>
                {`${HOLD_SCOPE_LABELS[hold.scope]} ${hold.scopeId}`}
              </h3>
              <span className="grow"></span>
              {hold.placedByMe ? (
                <Pill tone="neutral">Placed by you</Pill>
              ) : null}
              <Pill tone={hold.status === "active" ? "warning" : "neutral"}>
                {HOLD_STATUS_LABELS[hold.status]}
              </Pill>
            </div>
            <KeyValues
              items={[
                ["Reason", hold.reason],
                ["Started", utcText(hold.startedAt)],
                ...(hold.releasedAt === null
                  ? []
                  : ([["Released", utcText(hold.releasedAt)]] as const)),
              ]}
            />
            {hold.status === "active" ? (
              <ReleaseHoldForm hold={hold.id} />
            ) : null}
          </section>
        ))
      )}
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
