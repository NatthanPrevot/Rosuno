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

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  jurisdictionLabel,
  REFERRAL_COUNT_METRICS,
  resolveReferralOperations,
} from "../../../src/application/operations-workspace.ts";
import { OPERATIONS_WORKSPACE_SOURCES } from "../../../src/infrastructure/staff/operations-adapter.ts";
import {
  ButtonLink,
  Cluster,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import {
  ALLOCATION_LABELS,
  REFERRAL_COUNT_LABELS,
  REFERRAL_INTRO,
  STATE_LABELS,
  utcText,
} from "../../../src/presentation/operations-labels.ts";
import { requireSteppedUp } from "../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../frame.tsx";

export const metadata: Metadata = {
  title: "Referral operations",
  robots: { index: false, follow: false },
};

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
    <StaffFrame eyebrow="Referrals" title="Referral operations">
      <BackLink href="/staff">Staff tools</BackLink>
      <Text tone="muted">{REFERRAL_INTRO}</Text>
      <Table id="referral-counts" caption="Referrals in your scope">
        <tbody>
          {REFERRAL_COUNT_METRICS.map((metric) => (
            <tr key={metric}>
              <th scope="row">{REFERRAL_COUNT_LABELS[metric]}</th>
              <td>{view.counts[metric]}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      {view.referrals.length === 0 ? (
        <Text>
          {view.pager.page === 1
            ? "There are no referrals in your scope."
            : "There are no referrals on this page."}
        </Text>
      ) : (
        <Table id="referrals" caption="Referrals, newest first">
          <thead>
            <tr>
              <th scope="col">Created (UTC)</th>
              <th scope="col">Jurisdiction</th>
              <th scope="col">Attempt</th>
              <th scope="col">Allocation</th>
              <th scope="col">Outcome</th>
              <th scope="col">Request</th>
              <th scope="col">Consultation</th>
            </tr>
          </thead>
          <tbody>
            {view.referrals.map((referral) => (
              <tr key={referral.id}>
                <td>{utcText(referral.createdAt)}</td>
                <td>
                  {jurisdictionLabel(view.names, referral.jurisdictionId)}
                </td>
                <td>{referral.attemptOrdinal}</td>
                <td>
                  {ALLOCATION_LABELS[referral.allocationMethod] ??
                    referral.allocationMethod}
                </td>
                <td>
                  {referral.outcomeCode === null ||
                  referral.outcomeRecordedAt === null
                    ? "Not recorded"
                    : `${referral.outcomeCode} (${utcText(referral.outcomeRecordedAt)})`}
                </td>
                <td>
                  {referral.requestState === null
                    ? "None"
                    : (STATE_LABELS[referral.requestState] ??
                      referral.requestState)}
                </td>
                <td>
                  {referral.consultationState === null
                    ? "None"
                    : (STATE_LABELS[referral.consultationState] ??
                      referral.consultationState)}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Cluster>
        {view.pager.page > 1 ? (
          <ButtonLink
            variant="secondary"
            href={`/staff/referrals?page=${view.pager.page - 1}`}
          >
            Previous page
          </ButtonLink>
        ) : null}
        {view.pager.hasNext ? (
          <ButtonLink
            variant="secondary"
            href={`/staff/referrals?page=${view.pager.page + 1}`}
          >
            Next page
          </ButtonLink>
        ) : null}
      </Cluster>
    </StaffFrame>
  );
}
