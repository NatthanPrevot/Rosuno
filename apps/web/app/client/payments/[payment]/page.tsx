// The receipt of one of the client's payment attempts (MVP-001 S7; MBS
// section 12 client-facing payment status, receipt and refund surfaces).
//
// Rendered on the server for every request and never indexed. The route
// segment only names which of the client's own attempts to show; another
// client's or an unknown id gets the same not-found page. The receipt shows
// the client-side amounts of the Request's immutable Fee Calculation, the
// attempt's recorded state and amounts, and each refund as the ledger
// recorded it, with every instant in UTC. Rosuno holds no card data, so none
// is shown. The wording is fixed and neutral; nothing here states an
// entitlement or a settlement.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolvePaymentReceipt } from "../../../../src/application/client-payments.ts";
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
import { CLIENT_PAYMENT_SOURCES } from "../../../../src/infrastructure/payments/payment-adapter.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Eyebrow,
  Heading,
  Page,
  Stack,
  Status,
  Surface,
  Table,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import {
  moneyText,
  PAYMENT_STATE_LABELS,
  PAYMENT_STATUS_NOTE,
  utcText,
} from "../../../../src/presentation/payment-labels.ts";

export const metadata: Metadata = {
  title: "Payment receipt",
  robots: { index: false, follow: false },
};

function ReceiptFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="client">
      <Surface emphasis="raised" labelledBy="receipt-title">
        <Stack>
          <Eyebrow>Client workspace</Eyebrow>
          <Heading as="h1" size="lg" id="receipt-title">
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

export default async function PaymentReceiptPage({
  params,
}: {
  readonly params: Promise<{ readonly payment: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const { payment } = await params;
  const view = await resolvePaymentReceipt(CLIENT_PAYMENT_SOURCES, payment);
  if (view.status === "not-found") {
    notFound();
  }
  if (view.status === "sign-in-required") {
    return (
      <ReceiptFrame title="Sign in to continue">
        <Text>Sign in to your client account to see your payment receipt.</Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </ReceiptFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <ReceiptFrame title="Receipt unavailable">
        <Alert tone="error" title="Not available for this account" role="alert">
          Payment receipts are available to signed-in client accounts.
        </Alert>
      </ReceiptFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "payments.view_unavailable", {
      route: "/client/payments/[payment]",
      outcome: view.status,
    });
    return (
      <ReceiptFrame title="Receipt unavailable">
        <Alert tone="error" title="Something went wrong" role="alert">
          Your payment receipt could not be shown right now. Please try again
          later.
        </Alert>
      </ReceiptFrame>
    );
  }
  const receipt = view.receipt;
  const state = PAYMENT_STATE_LABELS[receipt.state];
  return (
    <ReceiptFrame title="Payment receipt">
      <Cluster>
        <Status tone={state.tone}>{state.label}</Status>
      </Cluster>
      <Table id="receipt-amounts" caption="The price of the request">
        <tbody>
          <tr>
            <th scope="row">Attorney&apos;s price</th>
            <td>{moneyText(receipt.listedPriceMinor, receipt.currency)}</td>
          </tr>
          <tr>
            <th scope="row">Client fee</th>
            <td>{moneyText(receipt.clientFeeMinor, receipt.currency)}</td>
          </tr>
          <tr>
            <th scope="row">Other required fees</th>
            <td>{moneyText(receipt.otherFeeMinor, receipt.currency)}</td>
          </tr>
          <tr>
            <th scope="row">Total</th>
            <td>{moneyText(receipt.totalMinor, receipt.currency)}</td>
          </tr>
        </tbody>
      </Table>
      <Table id="receipt-payment" caption="This payment">
        <tbody>
          <tr>
            <th scope="row">Started</th>
            <td>{utcText(receipt.createdAt)}</td>
          </tr>
          {receipt.authorizedAt === null ||
          receipt.amountAuthorizedMinor === null ? null : (
            <tr>
              <th scope="row">Authorized</th>
              <td>
                {`${moneyText(receipt.amountAuthorizedMinor, receipt.currency)} on ${utcText(receipt.authorizedAt)}`}
              </td>
            </tr>
          )}
          {receipt.capturedAt === null ||
          receipt.amountCapturedMinor === null ? null : (
            <tr>
              <th scope="row">Collected</th>
              <td>
                {`${moneyText(receipt.amountCapturedMinor, receipt.currency)} on ${utcText(receipt.capturedAt)}`}
              </td>
            </tr>
          )}
          <tr>
            <th scope="row">Refunded</th>
            <td>{moneyText(receipt.amountRefundedMinor, receipt.currency)}</td>
          </tr>
        </tbody>
      </Table>
      {receipt.refunds.length === 0 ? null : (
        <Table id="receipt-refunds" caption="Refunds">
          <thead>
            <tr>
              <th scope="col">Recorded</th>
              <th scope="col">Amount</th>
            </tr>
          </thead>
          <tbody>
            {receipt.refunds.map((refund, index) => (
              <tr key={index}>
                <td>{utcText(refund.effectiveAt)}</td>
                <td>{moneyText(refund.amountMinor, receipt.currency)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Text tone="muted">{PAYMENT_STATUS_NOTE}</Text>
      <Cluster>
        <ButtonLink
          variant="tertiary"
          href={`/client/requests/${receipt.requestId}`}
        >
          Back to the request
        </ButtonLink>
      </Cluster>
    </ReceiptFrame>
  );
}
