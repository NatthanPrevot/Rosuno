// Finance: one payment (MVP-001 S7; PS sections 22.2, 22.3 and 23.1; FP-1).
//
// Rendered on the server for every request. The route segment only names
// which payment to show; an unknown id gets the not-found page, and access
// needs the global manage_financial_operations capability at aal2 (the
// database decides again). The page shows the payment's recorded state and
// amounts, the Fee Calculation components, the provider reference, the FP-1
// provenance (jurisdiction, Regulatory Mode and the seven policy versions),
// its ledger entries in posting order, and its provider event receipts (type
// and processing outcome; no payload). Rosuno holds no card data. Staff can
// request a refund within what remains of each component, with a reason (the
// refund entitlement is policy, not decided here), and ask the worker to
// reconcile this payment with the provider.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import {
  REFUND_COMPONENTS,
  resolveFinancePayment,
  type RefundComponent,
} from "../../../../src/application/finance-workspace.ts";
import { FINANCE_SOURCES } from "../../../../src/infrastructure/payments/payment-adapter.ts";
import {
  Heading,
  Stack,
  Status,
  Table,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import {
  ENTRY_TYPE_LABELS,
  moneyText,
  REFUND_NOTE,
  STAFF_PAYMENT_STATE_LABELS,
  utcText,
} from "../../../../src/presentation/payment-labels.ts";
import { requireSteppedUp } from "../../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../../frame.tsx";
import { ReconcileForm, RefundForm } from "../forms.tsx";

export const metadata: Metadata = {
  title: "Payment",
  robots: { index: false, follow: false },
};

const POLICY_TYPES = Object.freeze([
  "referral",
  "payment",
  "fee",
  "payment_flow",
  "engagement",
  "cancellation",
  "refund",
]);

export default async function FinancePaymentPage({
  params,
}: {
  readonly params: Promise<{ readonly payment: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { payment: paymentId } = await params;
  const view = await resolveFinancePayment(FINANCE_SOURCES, paymentId);
  if (view.status === "not-found") {
    notFound();
  }
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/finance/[payment]", "Finance");
  }
  const { payment, ledger, receipts, refundable } = view;
  const refundableNow =
    payment.state === "captured" || payment.state === "partially_refunded";
  const remaining = Object.fromEntries(
    REFUND_COMPONENTS.map((component) => [
      component,
      moneyText(refundable[component], payment.currency),
    ]),
  ) as Record<RefundComponent, string>;
  return (
    <StaffFrame eyebrow="Finance" title="Payment">
      <BackLink href="/staff/finance">All payments</BackLink>
      <Table id="finance-payment" caption="Recorded state">
        <tbody>
          <tr>
            <th scope="row">State</th>
            <td>
              <Status tone="neutral">
                {STAFF_PAYMENT_STATE_LABELS[payment.state]}
              </Status>
            </td>
          </tr>
          <tr>
            <th scope="row">Request</th>
            <td>{`${payment.requestId} (${payment.requestPath}, ${payment.requestState.replaceAll("_", " ")})`}</td>
          </tr>
          <tr>
            <th scope="row">Authorized</th>
            <td>
              {payment.authorizedMinor === null
                ? "None"
                : `${moneyText(payment.authorizedMinor, payment.currency)}${payment.authorizedAt === null ? "" : ` on ${utcText(payment.authorizedAt)}`}`}
            </td>
          </tr>
          <tr>
            <th scope="row">Captured</th>
            <td>
              {payment.capturedMinor === null
                ? "None"
                : `${moneyText(payment.capturedMinor, payment.currency)}${payment.capturedAt === null ? "" : ` on ${utcText(payment.capturedAt)}`}`}
            </td>
          </tr>
          <tr>
            <th scope="row">Refunded</th>
            <td>{moneyText(payment.refundedMinor, payment.currency)}</td>
          </tr>
          {payment.failedAt === null ? null : (
            <tr>
              <th scope="row">Failed</th>
              <td>{utcText(payment.failedAt)}</td>
            </tr>
          )}
          <tr>
            <th scope="row">Provider</th>
            <td>{`${payment.providerCode}${payment.providerReference === null ? "" : `: ${payment.providerReference}`}`}</td>
          </tr>
          <tr>
            <th scope="row">Created</th>
            <td>{utcText(payment.createdAt)}</td>
          </tr>
        </tbody>
      </Table>
      <Table id="finance-fee" caption="Fee Calculation components">
        <tbody>
          <tr>
            <th scope="row">Attorney&apos;s listed price</th>
            <td>{moneyText(payment.listedPriceMinor, payment.currency)}</td>
          </tr>
          <tr>
            <th scope="row">Platform fee</th>
            <td>{moneyText(payment.platformFeeMinor, payment.currency)}</td>
          </tr>
          <tr>
            <th scope="row">Client fee</th>
            <td>{moneyText(payment.clientFeeMinor, payment.currency)}</td>
          </tr>
          <tr>
            <th scope="row">Other required fee</th>
            <td>{moneyText(payment.otherFeeMinor, payment.currency)}</td>
          </tr>
          <tr>
            <th scope="row">Client total</th>
            <td>{moneyText(payment.totalMinor, payment.currency)}</td>
          </tr>
        </tbody>
      </Table>
      <Table id="finance-provenance" caption="Provenance">
        <tbody>
          <tr>
            <th scope="row">Jurisdiction</th>
            <td>{payment.jurisdictionId}</td>
          </tr>
          <tr>
            <th scope="row">Regulatory Mode</th>
            <td>{payment.regulatoryModeId}</td>
          </tr>
          {POLICY_TYPES.map((type) => (
            <tr key={type}>
              <th scope="row">{`${type.replaceAll("_", " ")} policy version`}</th>
              <td>{payment.policies[type]}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Heading as="h2" size="md">
        Ledger
      </Heading>
      {ledger.length === 0 ? (
        <Text>There are no ledger entries for this payment.</Text>
      ) : (
        <Table id="finance-ledger" caption="Ledger entries">
          <thead>
            <tr>
              <th scope="col">Effective</th>
              <th scope="col">Entry</th>
              <th scope="col">Direction</th>
              <th scope="col">Amount</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((line) => (
              <tr key={line.id}>
                <td>{utcText(line.effectiveAt)}</td>
                <td>{ENTRY_TYPE_LABELS[line.entryType]}</td>
                <td>{line.direction}</td>
                <td>{moneyText(line.amountMinor, line.currency)}</td>
                <td>{line.sourceReference}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Heading as="h2" size="md">
        Provider events
      </Heading>
      {receipts.length === 0 ? (
        <Text>No provider event is recorded for this payment.</Text>
      ) : (
        <Table id="finance-receipts" caption="Provider event receipts">
          <thead>
            <tr>
              <th scope="col">Received</th>
              <th scope="col">Event</th>
              <th scope="col">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((receipt) => (
              <tr key={receipt.eventReference}>
                <td>{utcText(receipt.receivedAt)}</td>
                <td>{receipt.eventType}</td>
                <td>{receipt.processing.replaceAll("_", " ")}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {payment.providerReference === null ? null : (
        <ReconcileForm payment={payment.id} label="Reconcile this payment" />
      )}
      {refundableNow ? (
        <Stack gap="tight">
          <Heading as="h2" size="md">
            Refund
          </Heading>
          <Text tone="muted">{REFUND_NOTE}</Text>
          <RefundForm payment={payment.id} remaining={remaining} />
        </Stack>
      ) : null}
    </StaffFrame>
  );
}
