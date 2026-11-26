// The client's payment history (MVP-001 S11 pass 2B; MBS sections 12 and
// 18.2 "payments").
//
// Rendered on the server for every request and never indexed. The verified
// client of the request decides access (the client intake sources); the
// database answers only the client's own payment attempts, newest first, 25
// a page. The one query value read, page, only names the page; the server
// checks it and shows the first page for anything else. Each attempt shows
// the state and amounts Rosuno recorded (a refund as the recorded refunded
// amount) and links to its existing receipt page, which shows the components
// and each refund as the ledger recorded it. Read-only; nothing here states
// an entitlement or a settlement. DEV-001: the owner's UI/UX design, the
// client account's Payments: one calm row per attempt, opening its receipt.
// The design's saved payment methods have no record, so they are not
// offered.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveClientPayments } from "../../../src/application/participant-workspaces.ts";
import { getShellView } from "../../../src/application/shell.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../src/infrastructure/identity/server-session-source.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { CLIENT_WORKSPACE_SOURCES } from "../../../src/infrastructure/workspaces/workspace-adapter.ts";
import {
  ClientAccount,
  ClientGate,
  ClientPill,
  whenText,
} from "../../../src/presentation/client-account.tsx";
import { Alert } from "../../../src/presentation/design-system.tsx";
import {
  PAYMENT_STATE_LABELS,
  PAYMENT_STATUS_NOTE,
} from "../../../src/presentation/payment-labels.ts";
import { SitePage } from "../../../src/presentation/site-chrome.tsx";
import {
  moneyText,
  NO_PAYMENTS,
  PAYMENTS_INTRO,
  refundText,
  TIMES_NOTE,
} from "../../../src/presentation/workspace-labels.ts";
import { signOut } from "../../sign-in/actions.ts";

export const metadata: Metadata = {
  title: "Your payments",
  robots: { index: false, follow: false },
};

function pageHref(page: number): string {
  return page === 1 ? "/client/payments" : `/client/payments?page=${page}`;
}

export default async function ClientPaymentsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string | string[] }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const shell = await getShellView(SUPABASE_SERVER_SESSION_SOURCE);
  const { page } = await searchParams;
  const view = await resolveClientPayments(CLIENT_WORKSPACE_SOURCES, page);
  if (view.status === "sign-in-required") {
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Sign in to continue">
          <p className="sm muted">
            Your payments are available only to their signed-in client.
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
        <ClientGate heading="Payments">
          <Alert tone="warning" title="Not available" role="status">
            This account does not have client payments.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "client_payment_history.unavailable", {
      route: "/client/payments",
      outcome: view.status,
    });
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Payments">
          <Alert tone="error" title="Something went wrong" role="alert">
            Your payments could not be shown right now. Please try again later.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  const count = view.payments.length;
  const paged = view.pager.page > 1 || view.pager.hasNext;
  return (
    <SitePage session={shell.session} signOut={signOut}>
      <ClientAccount area="payments" heading="Payments">
        {count === 0 && view.pager.page === 1 ? (
          <section
            className="cx-card l-mt18-p40-28-dflex-fdcolumn-aicente-8ccc4d"
            aria-labelledby="py-empty-h"
          >
            <h2 className="h4" id="py-empty-h">
              No payments yet
            </h2>
            <p className="sm muted l-mt4-mw460">{NO_PAYMENTS}</p>
            <a className="btn btn-ink btn-sm l-mt16" href="/find-an-attorney">
              Find an attorney
            </a>
          </section>
        ) : (
          <>
            <div className="cx-tools l-fwrwrap-g10">
              <p className="sm muted">
                {paged
                  ? `Page ${view.pager.page}, newest first`
                  : count === 1
                    ? "1 payment"
                    : `${count} payments`}
              </p>
            </div>
            <p className="xs subtle l-mt6-mw640">
              {`${PAYMENTS_INTRO} ${TIMES_NOTE}`}
            </p>
            <ul
              className="stack l-g10-mt14-p0-lstnone"
              aria-label="Your payments"
            >
              {view.payments.map((payment) => {
                const state = PAYMENT_STATE_LABELS[payment.state];
                const refund = refundText(
                  payment.state,
                  payment.refundedMinor,
                  moneyText(payment.refundedMinor, payment.currency),
                );
                return (
                  <li key={payment.id}>
                    <a
                      className="cx-card l-dflex-w100pc-p16-20-g12-aicenter-j-730d17 rz-cx-row"
                      href={`/client/payments/${payment.id}`}
                    >
                      <span className="stack l-g2-minw0">
                        <span className="sm l-fw600 rz-cx-rt">
                          Consultation request payment
                        </span>
                        <span className="xs subtle">
                          {`Started ${whenText(payment.createdAt)}`}
                          {refund === null ? null : ` · ${refund}`}
                        </span>
                      </span>
                      <span className="row l-g10-aicenter">
                        <span className="sm num l-fw600">
                          {moneyText(payment.totalMinor, payment.currency)}
                        </span>
                        <ClientPill tone={state.tone}>{state.label}</ClientPill>
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <p className="xs subtle l-mt14">{PAYMENT_STATUS_NOTE}</p>
        {paged ? (
          <div className="row l-g8 l-mt14">
            {view.pager.page > 1 ? (
              <a
                className="btn btn-line btn-sm"
                href={pageHref(view.pager.page - 1)}
              >
                Show newer payments
              </a>
            ) : null}
            {view.pager.hasNext ? (
              <a
                className="btn btn-line btn-sm"
                href={pageHref(view.pager.page + 1)}
              >
                Show older payments
              </a>
            ) : null}
          </div>
        ) : null}
      </ClientAccount>
    </SitePage>
  );
}
