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
// entitlement or a settlement. DEV-001: the owner's UI/UX design, the client
// account's payment detail: the price rows, the payment history as the
// ledger recorded it, and the design's gated receipt download.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolvePaymentReceipt } from "../../../../src/application/client-payments.ts";
import { getShellView } from "../../../../src/application/shell.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../../src/infrastructure/identity/server-session-source.ts";
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
import { CLIENT_PAYMENT_SOURCES } from "../../../../src/infrastructure/payments/payment-adapter.ts";
import {
  ClientAccount,
  ClientGate,
  ClientPill,
  NotAvailableYet,
  TIMES_IN_UTC,
  whenText,
} from "../../../../src/presentation/client-account.tsx";
import { Alert } from "../../../../src/presentation/design-system.tsx";
import {
  moneyText,
  PAYMENT_STATE_LABELS,
  PAYMENT_STATUS_NOTE,
} from "../../../../src/presentation/payment-labels.ts";
import { SitePage } from "../../../../src/presentation/site-chrome.tsx";
import { signOut } from "../../../sign-in/actions.ts";

export const metadata: Metadata = {
  title: "Payment receipt",
  robots: { index: false, follow: false },
};

// One price row of the design.
function PriceRow({
  label,
  strong = false,
  children,
}: {
  readonly label: string;
  readonly strong?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="cx-prow">
      <span className="muted">{label}</span>
      <span className={strong ? "l-fw600" : undefined}>{children}</span>
    </div>
  );
}

// One entry of the design's payment history.
function HistoryEntry({
  label,
  at,
}: {
  readonly label: string;
  readonly at: string;
}) {
  return (
    <div className="cx-tli">
      <i />
      <span className="l-minw0">
        <span className="l-dblock">{label}</span>
      </span>
      <span className="at">{whenText(at)}</span>
    </div>
  );
}

export default async function PaymentReceiptPage({
  params,
}: {
  readonly params: Promise<{ readonly payment: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const shell = await getShellView(SUPABASE_SERVER_SESSION_SOURCE);
  const { payment } = await params;
  const view = await resolvePaymentReceipt(CLIENT_PAYMENT_SOURCES, payment);
  if (view.status === "not-found") {
    notFound();
  }
  if (view.status === "sign-in-required") {
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Sign in to continue">
          <p className="sm muted">
            Sign in to your client account to see your payment receipt.
          </p>
          <a className="btn btn-ink" href="/sign-in">
            Sign in
          </a>
        </ClientGate>
      </SitePage>
    );
  }
  if (view.status === "denied") {
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Receipt unavailable">
          <Alert
            tone="error"
            title="Not available for this account"
            role="alert"
          >
            Payment receipts are available to signed-in client accounts.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "payments.view_unavailable", {
      route: "/client/payments/[payment]",
      outcome: view.status,
    });
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Receipt unavailable">
          <Alert tone="error" title="Something went wrong" role="alert">
            Your payment receipt could not be shown right now. Please try again
            later.
          </Alert>
          <a className="link sm" href="/client/payments">
            ← All payments
          </a>
        </ClientGate>
      </SitePage>
    );
  }
  const receipt = view.receipt;
  const state = PAYMENT_STATE_LABELS[receipt.state];
  return (
    <SitePage session={shell.session} signOut={signOut}>
      <ClientAccount area="payments" heading="Payment receipt">
        <a className="link sm" href="/client/payments">
          ← All payments
        </a>
        <section
          className="cx-card l-mt12-p22-24"
          aria-labelledby="receipt-title"
        >
          <div className="row between l-g12-fwrwrap-aiflex-start">
            <div className="stack l-g2-minw0">
              <h2 className="h4" id="receipt-title">
                Consultation request payment
              </h2>
              <p className="xs subtle">
                {`Started ${whenText(receipt.createdAt)}`}
              </p>
            </div>
            <ClientPill tone={state.tone}>{state.label}</ClientPill>
          </div>
          <p className="sm muted l-mt8">{PAYMENT_STATUS_NOTE}</p>
          <div className="stack l-g2-mt16">
            <PriceRow label="Attorney's price">
              {moneyText(receipt.listedPriceMinor, receipt.currency)}
            </PriceRow>
            <PriceRow label="Client fee">
              {moneyText(receipt.clientFeeMinor, receipt.currency)}
            </PriceRow>
            <PriceRow label="Other required fees">
              {moneyText(receipt.otherFeeMinor, receipt.currency)}
            </PriceRow>
            <PriceRow label="Total" strong>
              {moneyText(receipt.totalMinor, receipt.currency)}
            </PriceRow>
          </div>
          <div className="row l-g10-mt16-fwrwrap">
            <a
              className="btn btn-line btn-sm"
              href={`/client/requests/${receipt.requestId}`}
            >
              Back to the request
            </a>
          </div>
        </section>
        <section
          className="cx-card l-mt12-p18-22"
          aria-labelledby="receipt-history"
        >
          <div className="row between l-g12-aibaseline-fwrwrap">
            <h3 className="sm l-fw600" id="receipt-history">
              Payment history
            </h3>
            <span className="xs subtle">{TIMES_IN_UTC}</span>
          </div>
          <div className="cx-tl">
            <HistoryEntry label="Started" at={receipt.createdAt} />
            {receipt.authorizedAt === null ||
            receipt.amountAuthorizedMinor === null ? null : (
              <HistoryEntry
                label={`Authorized ${moneyText(receipt.amountAuthorizedMinor, receipt.currency)}`}
                at={receipt.authorizedAt}
              />
            )}
            {receipt.capturedAt === null ||
            receipt.amountCapturedMinor === null ? null : (
              <HistoryEntry
                label={`Collected ${moneyText(receipt.amountCapturedMinor, receipt.currency)}`}
                at={receipt.capturedAt}
              />
            )}
            {receipt.refunds.map((refund, index) => (
              <HistoryEntry
                key={index}
                label={`Refund recorded ${moneyText(refund.amountMinor, receipt.currency)}`}
                at={refund.effectiveAt}
              />
            ))}
          </div>
          <PriceRow label="Refunded">
            {moneyText(receipt.amountRefundedMinor, receipt.currency)}
          </PriceRow>
        </section>
        <section
          className="cx-card l-mt12-p18-22"
          aria-labelledby="receipt-download"
        >
          <h3 className="sm l-fw600" id="receipt-download">
            Receipt
          </h3>
          <NotAvailableYet
            title="Download receipt"
            reason="the receipt format is not decided."
            placeholder="[receipt format — per payment policy]"
          />
        </section>
      </ClientAccount>
    </SitePage>
  );
}
