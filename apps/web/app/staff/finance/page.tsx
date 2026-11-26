// Finance: payments (MVP-001 S7; TA section 18 Finance; PS section 22.2).
//
// Rendered on the server for every request. A fresh staff identity and the
// database's own capability predicate decide access: the view needs the
// global manage_financial_operations capability at aal2, exactly as the
// finance functions do. One group of payments is listed at a time, one page
// at a time: in flight, collected, ended, or all. Each row shows the state,
// the amounts in the payment's currency and the number of open
// reconciliation exceptions; never card data (Rosuno holds none). Staff can
// ask the worker to reconcile every live payment with the provider; the
// database enqueues it and audits the request. The two query values read,
// group and page, only choose the group and the page; the server checks both.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Platform › Finance,
// payments): the design's group tabs and list, one row per payment opening its
// record, and the reconciliation request for every live payment.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  PAYMENT_GROUPS,
  resolveFinancePayments,
} from "../../../src/application/finance-workspace.ts";
import { FINANCE_SOURCES } from "../../../src/infrastructure/payments/payment-adapter.ts";
import {
  FINANCE_INTRO,
  moneyText,
  PAYMENT_GROUP_LINKS,
  STAFF_PAYMENT_STATE_LABELS,
  utcText,
} from "../../../src/presentation/payment-labels.ts";
import {
  Cell,
  Empty,
  ListBox,
  ListRow,
  PagerRow,
  Panel,
  PillCell,
  TabLinks,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { refusalPage, StaffFrame } from "../frame.tsx";
import { ReconcileForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Finance",
  robots: { index: false, follow: false },
};

const COLUMNS = [
  "Created (UTC)",
  "Total",
  "Captured",
  "Refunded",
  "Open exceptions",
  "State",
] as const;

export default async function FinancePaymentsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly group?: string | string[];
    readonly page?: string | string[];
  }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { group, page } = await searchParams;
  const view = await resolveFinancePayments(FINANCE_SOURCES, group, page);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/finance", "Finance");
  }
  const base = PAYMENT_GROUP_LINKS[view.group].href;
  return (
    <StaffFrame
      title="Finance"
      subtitle="Payments as Rosuno records them, with their ledger and reconciliation."
      lead={<p>{FINANCE_INTRO}</p>}
      utc
    >
      <TabLinks
        label="Payments by group"
        links={PAYMENT_GROUPS.map((entry) => ({
          href: PAYMENT_GROUP_LINKS[entry].href,
          label: PAYMENT_GROUP_LINKS[entry].title,
        }))}
        current={base}
      />
      <ListBox
        label={`${PAYMENT_GROUP_LINKS[view.group].title} payments`}
        columns={COLUMNS}
      >
        {view.payments.length === 0 ? (
          <Empty
            title={
              view.pager.page === 1
                ? "There are no payments in this group."
                : "There are no payments on this page."
            }
          />
        ) : (
          view.payments.map((payment) => (
            <ListRow
              key={payment.id}
              href={`/staff/finance/${payment.id}`}
              columns={6}
            >
              <Cell label="Created" strong>
                {utcText(payment.createdAt)}
              </Cell>
              <Cell label="Total">
                {moneyText(payment.totalMinor, payment.currency)}
              </Cell>
              <Cell label="Captured">
                {payment.capturedMinor === null
                  ? "None"
                  : moneyText(payment.capturedMinor, payment.currency)}
              </Cell>
              <Cell label="Refunded">
                {moneyText(payment.refundedMinor, payment.currency)}
              </Cell>
              <Cell label="Open exceptions">{payment.openExceptions}</Cell>
              <PillCell label="State" tone="neutral">
                {STAFF_PAYMENT_STATE_LABELS[payment.state]}
              </PillCell>
            </ListRow>
          ))
        )}
      </ListBox>
      {view.pager.page === 1 && !view.pager.hasNext ? null : (
        <PagerRow
          note={`Page ${view.pager.page} of this group.`}
          previous={
            view.pager.page > 1
              ? view.pager.page === 2
                ? base
                : `${base}&page=${view.pager.page - 1}`
              : null
          }
          next={
            view.pager.hasNext ? `${base}&page=${view.pager.page + 1}` : null
          }
        />
      )}
      <Panel id="finance-reconcile-title" title="Reconciliation">
        <p className="st-emd">
          Ask the worker to compare every live payment with the provider. A
          disagreement opens a reconciliation exception for review.
        </p>
        <ReconcileForm payment={null} label="Reconcile every live payment" />
      </Panel>
    </StaffFrame>
  );
}
