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

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  PAYMENT_GROUPS,
  resolveFinancePayments,
} from "../../../src/application/finance-workspace.ts";
import { FINANCE_SOURCES } from "../../../src/infrastructure/payments/payment-adapter.ts";
import {
  ButtonLink,
  Cluster,
  Status,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import {
  FINANCE_INTRO,
  moneyText,
  PAYMENT_GROUP_LINKS,
  STAFF_PAYMENT_STATE_LABELS,
  utcText,
} from "../../../src/presentation/payment-labels.ts";
import { requireSteppedUp } from "../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../frame.tsx";
import { ReconcileForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Finance",
  robots: { index: false, follow: false },
};

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
    <StaffFrame eyebrow="Staff" title="Finance">
      <BackLink href="/staff">Staff tools</BackLink>
      <Text tone="muted">{FINANCE_INTRO}</Text>
      <Cluster>
        <ButtonLink variant="secondary" href="/staff/finance/exceptions">
          Reconciliation exceptions
        </ButtonLink>
      </Cluster>
      <ReconcileForm payment={null} label="Reconcile every live payment" />
      <Cluster>
        {PAYMENT_GROUPS.map((entry) => (
          <ButtonLink
            key={entry}
            variant={entry === view.group ? "primary" : "secondary"}
            href={PAYMENT_GROUP_LINKS[entry].href}
            aria-current={entry === view.group ? "page" : undefined}
          >
            {PAYMENT_GROUP_LINKS[entry].title}
          </ButtonLink>
        ))}
      </Cluster>
      {view.payments.length === 0 ? (
        <Text>
          {view.pager.page === 1
            ? "There are no payments in this group."
            : "There are no payments on this page."}
        </Text>
      ) : (
        <Table
          id="finance-payments"
          caption={`${PAYMENT_GROUP_LINKS[view.group].title} payments`}
        >
          <thead>
            <tr>
              <th scope="col">Created</th>
              <th scope="col">State</th>
              <th scope="col">Total</th>
              <th scope="col">Captured</th>
              <th scope="col">Refunded</th>
              <th scope="col">Open exceptions</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            {view.payments.map((payment) => (
              <tr key={payment.id}>
                <td>{utcText(payment.createdAt)}</td>
                <td>
                  <Status tone="neutral">
                    {STAFF_PAYMENT_STATE_LABELS[payment.state]}
                  </Status>
                </td>
                <td>{moneyText(payment.totalMinor, payment.currency)}</td>
                <td>
                  {payment.capturedMinor === null
                    ? "None"
                    : moneyText(payment.capturedMinor, payment.currency)}
                </td>
                <td>{moneyText(payment.refundedMinor, payment.currency)}</td>
                <td>{payment.openExceptions}</td>
                <td>
                  <ButtonLink
                    variant="tertiary"
                    href={`/staff/finance/${payment.id}`}
                  >
                    Open
                  </ButtonLink>
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
            href={
              view.pager.page === 2
                ? base
                : `${base}&page=${view.pager.page - 1}`
            }
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
