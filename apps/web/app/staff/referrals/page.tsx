// Referral operations (MVP-001 S11 pass 2; MBS sections 16 and 18.4
// "referral / allocation operations"; TA sections 18 and 41).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs view_referral_operations in some scope (the
// database lists only the Referrals of the jurisdictions the caller covers).
// Read-only: counts and one page of Referrals, newest first, with the linked
// Request and Consultation states. No intake content, client identity
// beyond ids or other attorneys' details, and no write action (the outcome
// taxonomy is gated configuration). The one query value read, page, only
// chooses the page.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Bookings & consultations):
// the design's headline figures for the four counts, then the design's list
// of Referrals (read-only rows, no record page).

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  jurisdictionLabel,
  REFERRAL_COUNT_METRICS,
  resolveReferralOperations,
} from "../../../src/application/operations-workspace.ts";
import { OPERATIONS_WORKSPACE_SOURCES } from "../../../src/infrastructure/staff/operations-adapter.ts";
import {
  ALLOCATION_LABELS,
  REFERRAL_COUNT_LABELS,
  REFERRAL_INTRO,
  STATE_LABELS,
  utcText,
} from "../../../src/presentation/operations-labels.ts";
import {
  Cell,
  Empty,
  ListBox,
  ListRow,
  Metric,
  Metrics,
  PagerRow,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { refusalPage, StaffFrame } from "../frame.tsx";

export const metadata: Metadata = {
  title: "Referral operations",
  robots: { index: false, follow: false },
};

const COLUMNS = [
  "Created (UTC)",
  "Allocation",
  "Outcome",
  "Request",
  "Consultation",
] as const;

export default async function ReferralOperationsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string | string[] }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { page } = await searchParams;
  const view = await resolveReferralOperations(
    OPERATIONS_WORKSPACE_SOURCES,
    page,
  );
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/referrals", "Referral operations");
  }
  return (
    <StaffFrame
      title="Bookings & consultations"
      description="Referrals, their outcomes and the requests they led to."
      lead={<p>{REFERRAL_INTRO}</p>}
      utc
    >
      <Metrics label="Referrals in your scope" count={4}>
        {REFERRAL_COUNT_METRICS.map((metric) => (
          <Metric
            key={metric}
            label={REFERRAL_COUNT_LABELS[metric]}
            value={view.counts[metric]}
          />
        ))}
      </Metrics>
      <ListBox label="Referrals, newest first" columns={COLUMNS} sub>
        {view.referrals.length === 0 ? (
          <Empty
            title={
              view.pager.page === 1
                ? "There are no referrals in your scope."
                : "There are no referrals on this page."
            }
          />
        ) : (
          view.referrals.map((referral) => (
            <ListRow key={referral.id} columns={5} sub>
              <Cell label="Created" strong>
                {utcText(referral.createdAt)}
              </Cell>
              <Cell label="">
                {`${jurisdictionLabel(view.names, referral.jurisdictionId)} · attempt ${referral.attemptOrdinal}`}
              </Cell>
              <Cell label="Allocation">
                {ALLOCATION_LABELS[referral.allocationMethod] ??
                  referral.allocationMethod}
              </Cell>
              <Cell label="Outcome">
                {referral.outcomeCode === null ||
                referral.outcomeRecordedAt === null
                  ? "Not recorded"
                  : `${referral.outcomeCode} (${utcText(referral.outcomeRecordedAt)})`}
              </Cell>
              <Cell label="Request">
                {referral.requestState === null
                  ? "None"
                  : (STATE_LABELS[referral.requestState] ??
                    referral.requestState)}
              </Cell>
              <Cell label="Consultation">
                {referral.consultationState === null
                  ? "None"
                  : (STATE_LABELS[referral.consultationState] ??
                    referral.consultationState)}
              </Cell>
            </ListRow>
          ))
        )}
      </ListBox>
      {view.pager.page === 1 && !view.pager.hasNext ? null : (
        <PagerRow
          note={`Page ${view.pager.page} of the referrals.`}
          previous={
            view.pager.page > 1
              ? `/staff/referrals?page=${view.pager.page - 1}`
              : null
          }
          next={
            view.pager.hasNext
              ? `/staff/referrals?page=${view.pager.page + 1}`
              : null
          }
        />
      )}
    </StaffFrame>
  );
}
