// One of the client's Consultation Requests (MVP-001 S6; MBS sections 11 and
// 18.6; DM sections 2.5 and 2.6).
//
// Rendered on the server for every request. The route segment only names
// which of the client's own Requests to show; another client's or an unknown
// id gets the same not-found page. The page shows the state the database
// reports (expired as soon as the server reports its deadline, quote or Hold
// passed, even before the expiry is recorded: the browser never decides
// it), the path, the attorney, the option, the held time for a scheduled
// Request, the server deadline and the quote's validity in UTC, and the
// immutable quote. While the Request is undecided and not past its deadline
// the client may withdraw it; the database decides again. MVP-001 S6 PS-A3:
// the option shows the duration the Request recorded, and the client's own
// message is shown as plain text, line by line (React escapes it; it is
// never rendered as markup). Nothing here shows anything of the attorney's
// side (S8).
//
// MVP-001 S7: the page also shows the payment step the database reports for
// the Request (an authorization before the attorney decision when the
// Request's payment flow asks for one; configuration decides), the latest
// attempt's recorded state with a link to its receipt, and, while an attempt
// can be started or continued, the authorization form. This page is where the
// payment provider's hosted page returns the client: the status shown is
// always the one Rosuno recorded, never what the browser or the provider page
// said. The wording is fixed and neutral.
//
// MVP-001 S8: the page also shows the attorney's decision the database
// reports: after an acceptance, the Consultation's state and, for a scheduled
// Request, its Booking's time (no attorney contact detail); after a decline
// or a Request that could not go ahead, a link back to the client's own
// Intake, from which the client selects an attorney again (a new Referral and
// a new Request; Rosuno names no other attorney). An accepted Request whose
// payment flow authorizes at the attorney's acceptance shows the
// authorization step (configuration decides).
//
// DEV-001: the owner's UI/UX design, the request status: the state, the
// decision, the payment step and the withdrawal in the main panel, the
// request's facts and price in the side panel. Every read, form and action
// is unchanged.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveRequestPayment } from "../../../../src/application/client-payments.ts";
import { clientConsultationPathFor } from "../../../../src/application/consultations.ts";
import {
  resolveConsultationRequest,
  resolveRequestDecision,
} from "../../../../src/application/consultation-request.ts";
import {
  getShellView,
  type ShellView,
} from "../../../../src/application/shell.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../../src/infrastructure/identity/server-session-source.ts";
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
import { CLIENT_PAYMENT_SOURCES } from "../../../../src/infrastructure/payments/payment-adapter.ts";
import { REQUEST_SOURCES } from "../../../../src/infrastructure/requests/consultation-request-adapter.ts";
import { ClientPill } from "../../../../src/presentation/client-account.tsx";
import { Alert, Text } from "../../../../src/presentation/design-system.tsx";
import {
  CONSULTATION_STATE_TEXT,
  COULD_NOT_PROCEED_LABEL,
  DECISION_ACCEPTED,
  DECISION_CONSULTATION_PENDING,
  DECISION_COULD_NOT_PROCEED,
  DECISION_DECLINED,
  durationText,
  EXPIRED_NOTE,
  modalityText,
  moneyText,
  REQUEST_PATH_LABELS,
  REQUEST_STATE_LABELS,
  SELECT_AGAIN_LABEL,
  SERVER_TIME_NOTE,
  utcText,
  YOUR_MESSAGE,
} from "../../../../src/presentation/request-labels.ts";
import {
  AUTHORIZE_LABEL,
  CONTINUE_LABEL,
  PAYMENT_STATE_LABELS,
  PAYMENT_STATUS_NOTE,
  PAYMENT_STEP_TEXT,
} from "../../../../src/presentation/payment-labels.ts";
import { SitePage } from "../../../../src/presentation/site-chrome.tsx";
import { signOut } from "../../../sign-in/actions.ts";
import { AuthorizePaymentForm, WithdrawRequestForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Your request",
  robots: { index: false, follow: false },
};

// The page outside the request itself (sign-in, refusal, unavailable): the
// heading and one panel.
function RequestFrame({
  session,
  title,
  children,
}: {
  readonly session: ShellView["session"];
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <SitePage session={session} signOut={signOut}>
      <div className="wrap m4-rq l-pt32-pb88-mw1200">
        <h1 className="h2 l-fs38">{title}</h1>
        <section className="panel l-p24-26 l-mt20 rz-rq-panel">
          {children}
        </section>
      </div>
    </SitePage>
  );
}

// The design's request status: the main panel beside the request's facts.
function StatusLayout({
  session,
  aside,
  children,
}: {
  readonly session: ShellView["session"];
  readonly aside: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <SitePage session={session} signOut={signOut}>
      <div className="wrap m4-rq l-pt32-pb88-mw1200">
        {BACK}
        <div className="m4-g2 l-dgrid-colsmm0-1fr-360-g28-aistart-mt8">
          <section
            className="panel l-p34-36-30 rz-rq-panel"
            aria-labelledby="request-title"
          >
            {children}
          </section>
          {aside}
        </div>
      </div>
    </SitePage>
  );
}

const BACK = (
  <a className="link sm" href="/client">
    ← Back to your account
  </a>
);

// One fact of the design's side panel and decision rows.
function Row({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="row between l-g14">
      <span className="sm muted">{label}</span>
      <span className="sm l-fw500-taright">{children}</span>
    </div>
  );
}

export default async function RequestPage({
  params,
}: {
  readonly params: Promise<{ readonly request: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const shell = await getShellView(SUPABASE_SERVER_SESSION_SOURCE);
  const { request } = await params;
  const view = await resolveConsultationRequest(REQUEST_SOURCES, request);
  if (view.status === "not-found") {
    notFound();
  }
  if (view.status === "sign-in-required") {
    return (
      <RequestFrame session={shell.session} title="Sign in to continue">
        <Text>Sign in to your client account to see your request.</Text>
        <a className="btn btn-ink rz-rq-start" href="/sign-in">
          Sign in
        </a>
      </RequestFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <RequestFrame session={shell.session} title="Request unavailable">
        <Alert tone="error" title="Not available for this account" role="alert">
          Requests are available to signed-in client accounts.
        </Alert>
      </RequestFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "consultation_request.view_unavailable", {
      route: "/client/requests/[request]",
      outcome: view.status,
    });
    return (
      <RequestFrame session={shell.session} title="Request unavailable">
        <Alert tone="error" title="Something went wrong" role="alert">
          Your request could not be shown right now. Please try again later.
        </Alert>
        {BACK}
      </RequestFrame>
    );
  }
  const record = view.request;
  const decisionView = await resolveRequestDecision(REQUEST_SOURCES, record.id);
  if (decisionView.status !== "ready") {
    await logRequestEvent("warn", "consultation_request.view_unavailable", {
      route: "/client/requests/[request]",
      outcome: `decision-${decisionView.status}`,
    });
  }
  const decision =
    decisionView.status === "ready" ? decisionView.decision : null;
  const state =
    decision?.endedReason === "could_not_proceed"
      ? COULD_NOT_PROCEED_LABEL
      : REQUEST_STATE_LABELS[view.displayState];
  const amounts = record.amounts;
  const paymentView = await resolveRequestPayment(
    CLIENT_PAYMENT_SOURCES,
    record.id,
  );
  if (paymentView.status !== "ready") {
    await logRequestEvent("warn", "payments.view_unavailable", {
      route: "/client/requests/[request]",
      outcome: paymentView.status,
    });
  }
  const payment = paymentView.status === "ready" ? paymentView.payment : null;
  const latest = payment?.latest ?? null;
  const aside = (
    <aside className="panel l-p22-24" aria-labelledby="request-attorney">
      <p className="lbl-sm">Request</p>
      <div className="stack l-g2 l-mt14">
        <span className="h4 l-fs16" id="request-attorney">
          {record.attorneyName ?? "Attorney not shown"}
        </span>
        <span className="xs subtle">{REQUEST_PATH_LABELS[record.path]}</span>
      </div>
      <div className="stack l-g10-mt16-pt14-bt1-solid-line">
        <Row label="Option">
          {record.durationMinutes === null
            ? modalityText(record.modality)
            : `${modalityText(record.modality)}, ${durationText(record.durationMinutes)}`}
        </Row>
        {record.slotStart === null || record.slotEnd === null ? null : (
          <Row label="Time">{`${utcText(record.slotStart)} to ${utcText(record.slotEnd)}`}</Row>
        )}
        <Row label="Requested">{utcText(record.createdAt)}</Row>
        {record.responseDeadline === null ? null : (
          <Row label="Response deadline">
            {utcText(record.responseDeadline)}
          </Row>
        )}
        {record.quoteValidUntil === null ? null : (
          <Row label="Price held until">{utcText(record.quoteValidUntil)}</Row>
        )}
      </div>
      {amounts === null ? null : (
        <div
          className="stack l-g10-mt16-pt14-bt1-solid-line"
          aria-label="The price of this request"
        >
          <Row label="Attorney's price">
            {moneyText(amounts.listedPriceMinor, amounts.currency)}
          </Row>
          <Row label="Client fee">
            {moneyText(amounts.clientFeeMinor, amounts.currency)}
          </Row>
          <Row label="Other required fees">
            {moneyText(amounts.otherFeeMinor, amounts.currency)}
          </Row>
          <Row label="Total">
            {moneyText(amounts.totalMinor, amounts.currency)}
          </Row>
        </div>
      )}
      <p className="xs subtle l-mt14">{SERVER_TIME_NOTE}</p>
    </aside>
  );
  return (
    <StatusLayout session={shell.session} aside={aside}>
      <div className="row l-g8">
        <ClientPill tone={state.tone}>{state.label}</ClientPill>
      </div>
      <h1 className="h2 l-fs34-mt16-mw640" id="request-title">
        Your request
      </h1>
      {view.displayState === "expired" ? <Text>{EXPIRED_NOTE}</Text> : null}
      {decision !== null && decision.state === "accepted" ? (
        <div className="stack l-g10">
          <h2 className="h4">Consultation</h2>
          {decision.consultationState === null ? (
            <Text>{DECISION_CONSULTATION_PENDING}</Text>
          ) : (
            <>
              <Text>{DECISION_ACCEPTED}</Text>
              <Row label="Status">
                {CONSULTATION_STATE_TEXT[decision.consultationState]}
              </Row>
              {decision.bookingStart === null ||
              decision.bookingEnd === null ? null : (
                <Row label="Time">{`${utcText(decision.bookingStart)} to ${utcText(decision.bookingEnd)}`}</Row>
              )}
              {decision.consultationId === null ? null : (
                <div className="row l-g10-mt24-fwrwrap">
                  <a
                    className="btn btn-ink"
                    href={clientConsultationPathFor(decision.consultationId)}
                  >
                    Go to your consultation
                  </a>
                </div>
              )}
            </>
          )}
        </div>
      ) : null}
      {decision !== null &&
      (decision.endedReason === "declined" ||
        decision.endedReason === "could_not_proceed") ? (
        <div className="stack l-g10">
          <Text>
            {decision.endedReason === "declined"
              ? DECISION_DECLINED
              : DECISION_COULD_NOT_PROCEED}
          </Text>
          <div className="row l-g10-fwrwrap">
            <a
              className="btn btn-line"
              href={`/client/intakes/${decision.intakeId}`}
            >
              {SELECT_AGAIN_LABEL}
            </a>
          </div>
        </div>
      ) : null}
      {record.message === null ? null : (
        <div className="stack l-g4">
          <h2 className="h4">{YOUR_MESSAGE}</h2>
          {record.message.split("\n").map((line, index) => (
            <Text key={index}>{line === "" ? "\u00a0" : line}</Text>
          ))}
        </div>
      )}
      <div className="stack l-g10 l-pt12-bt1-solid-line">
        <h2 className="h4">Payment</h2>
        {payment === null ? (
          <Alert tone="error" title="Payment status unavailable" role="alert">
            The payment status could not be shown right now. Please try again
            later.
          </Alert>
        ) : (
          <>
            <Text>{PAYMENT_STEP_TEXT[payment.step]}</Text>
            {latest === null ? null : (
              <div className="stack l-g10" aria-label="Latest payment">
                <Row label="Status">
                  <ClientPill tone={PAYMENT_STATE_LABELS[latest.state].tone}>
                    {PAYMENT_STATE_LABELS[latest.state].label}
                  </ClientPill>
                </Row>
                <Row label="Started">{utcText(latest.createdAt)}</Row>
                {latest.authorizedAt === null ? null : (
                  <Row label="Authorized">{utcText(latest.authorizedAt)}</Row>
                )}
                <div className="row l-g10-fwrwrap">
                  <a
                    className="btn btn-line btn-sm"
                    href={`/client/payments/${latest.id}`}
                  >
                    View payment receipt
                  </a>
                </div>
              </div>
            )}
            {payment.payable ? (
              <AuthorizePaymentForm
                requestId={record.id}
                label={
                  latest?.state === "pending_authorization"
                    ? CONTINUE_LABEL
                    : AUTHORIZE_LABEL
                }
              />
            ) : null}
            <p className="xs subtle">{PAYMENT_STATUS_NOTE}</p>
          </>
        )}
      </div>
      {view.withdrawable ? <WithdrawRequestForm requestId={record.id} /> : null}
    </StatusLayout>
  );
}
