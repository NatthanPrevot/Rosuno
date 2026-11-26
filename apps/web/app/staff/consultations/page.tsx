// Consultation operations: the Consultations nobody decided (MVP-001 S11;
// MBS section 16; TA sections 18 and 41; PS section 30.4).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs manage_consultation_operations in some scope, and
// the database lists only the undecided Consultations, in the jurisdictions
// the caller holds it for, whose outcome may now be recorded (the window
// rule), oldest first, with the three attendance facts and the latest payment
// state; never a participant's identity. Each links to its own page, where
// the outcome is recorded. Holders of the global grant also see the
// operations family's review items. The query values read (page, status and
// items page) only choose the pages and the list; the server checks them.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Bookings & consultations):
// the design's list, one row per consultation opening its own page (the
// booked time or how soon, since when an outcome may be recorded, the
// attendance facts, the latest payment state and the state pill), then the
// operations review items. Never a participant's identity.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  resolveFamilyExceptions,
  resolveStaleConsultations,
} from "../../../src/application/consultation-outcomes.ts";
import { OPERATIONS_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import {
  FAMILY_TITLES,
  OPERATIONS_NOTE,
  utcText,
  WINDOW_BASIS_LABELS,
} from "../../../src/presentation/completion-labels.ts";
import { PATH_LABELS } from "../../../src/presentation/consultation-labels.ts";
import {
  Cell,
  Empty,
  ListBox,
  ListRow,
  PagerRow,
  PillCell,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { refusalPage, StaffFrame } from "../frame.tsx";
import { ReviewItemList } from "../review-item-list.tsx";
import {
  assignOperationsItemAction,
  resolveOperationsItemAction,
} from "./actions.ts";

export const metadata: Metadata = {
  title: "Consultation operations",
  robots: { index: false, follow: false },
};

const yes = (value: boolean) => (value ? "yes" : "no");

const COLUMNS = [
  "Consultation (UTC)",
  "Attendance",
  "Payment",
  "State",
] as const;

export default async function StaffConsultationsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly page?: string | string[];
    readonly status?: string | string[];
    readonly items?: string | string[];
  }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { page, status, items } = await searchParams;
  const view = await resolveStaleConsultations(OPERATIONS_SOURCES, page);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/consultations", "Consultation operations");
  }
  const family = view.reviewItems
    ? await resolveFamilyExceptions(
        OPERATIONS_SOURCES,
        "operations",
        status,
        items,
      )
    : null;
  return (
    <StaffFrame
      title="Bookings & consultations"
      description="Consultations waiting for an outcome, and the operations review items."
      lead={<p>{OPERATIONS_NOTE}</p>}
      utc
    >
      <h2 className="st-h2" id="stale-title">
        Consultations waiting for an outcome
      </h2>
      <ListBox
        label="Consultations waiting for an outcome"
        columns={COLUMNS}
        sub
      >
        {view.consultations.length === 0 ? (
          <Empty
            title={
              view.pager.page === 1
                ? "No consultation is waiting for an outcome."
                : "There are no consultations on this page."
            }
            note="A consultation appears here once its time has passed and nobody ended it."
          />
        ) : (
          view.consultations.map((entry) => (
            <ListRow
              key={entry.id}
              href={`/staff/consultations/${entry.id}`}
              columns={4}
              sub
            >
              <Cell label="Consultation" strong>
                {entry.bookingStart === null
                  ? PATH_LABELS[entry.path]
                  : `${utcText(entry.bookingStart)} to ${entry.bookingEnd === null ? "" : utcText(entry.bookingEnd)}`}
              </Cell>
              <Cell label="">
                {`Outcome may be recorded since ${utcText(entry.recordableSince)} (${WINDOW_BASIS_LABELS[entry.windowBasis]})`}
              </Cell>
              <Cell label="Attendance">
                {`Attorney ${yes(entry.attorneyJoined)} · client ${yes(entry.clientJoined)} · together ${yes(entry.bothPresent)}`}
              </Cell>
              <Cell label="Payment">
                {entry.paymentState === null
                  ? "No payment"
                  : `payment ${entry.paymentState.replaceAll("_", " ")}`}
              </Cell>
              <PillCell label="State" tone="neutral">
                {entry.state}
              </PillCell>
            </ListRow>
          ))
        )}
      </ListBox>
      {view.pager.page === 1 && !view.pager.hasNext ? null : (
        <PagerRow
          note={`Page ${view.pager.page} of the consultations waiting for an outcome.`}
          previous={
            view.pager.page > 1
              ? `/staff/consultations?page=${view.pager.page - 1}`
              : null
          }
          next={
            view.pager.hasNext
              ? `/staff/consultations?page=${view.pager.page + 1}`
              : null
          }
        />
      )}
      {family === null ? null : (
        <>
          <h2 className="st-h2" id="operations-items-title">
            {FAMILY_TITLES.operations}
          </h2>
          {family.status !== "ready" ? (
            <p className="st-emd">
              The review items could not be shown right now.
            </p>
          ) : (
            <ReviewItemList
              view={family}
              base={`/staff/consultations?status=${family.exceptionStatus}`}
              pageParameter="items"
              assignAction={assignOperationsItemAction}
              resolveAction={resolveOperationsItemAction}
            />
          )}
        </>
      )}
    </StaffFrame>
  );
}
