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
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
import { CLIENT_PAYMENT_SOURCES } from "../../../../src/infrastructure/payments/payment-adapter.ts";
import { REQUEST_SOURCES } from "../../../../src/infrastructure/requests/consultation-request-adapter.ts";
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
import { AuthorizePaymentForm, WithdrawRequestForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Your request",
  robots: { index: false, follow: false },
};

function RequestFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="client">
      <Surface emphasis="raised" labelledBy="request-title">
        <Stack>
          <Eyebrow>Client workspace</Eyebrow>
          <Heading as="h1" size="lg" id="request-title">
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

const BACK = (
  <Cluster>
    <ButtonLink variant="tertiary" href="/client">
      Back to your workspace
    </ButtonLink>
  </Cluster>
);

export default async function RequestPage({
  params,
}: {
  readonly params: Promise<{ readonly request: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const { request } = await params;
  const view = await resolveConsultationRequest(REQUEST_SOURCES, request);
  if (view.status === "not-found") {
    notFound();
  }
  if (view.status === "sign-in-required") {
    return (
      <RequestFrame title="Sign in to continue">
        <Text>Sign in to your client account to see your request.</Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </RequestFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <RequestFrame title="Request unavailable">
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
      <RequestFrame title="Request unavailable">
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
  return (
    <RequestFrame title="Your request">
      <Cluster>
        <Status tone={state.tone}>{state.label}</Status>
      </Cluster>
      {view.displayState === "expired" ? <Text>{EXPIRED_NOTE}</Text> : null}
      <Table id="request-details" caption="Request details">
        <tbody>
          <tr>
            <th scope="row">Attorney</th>
            <td>{record.attorneyName ?? "Not shown"}</td>
          </tr>
          <tr>
            <th scope="row">How soon</th>
            <td>{REQUEST_PATH_LABELS[record.path]}</td>
          </tr>
          <tr>
            <th scope="row">Option</th>
            <td>
              {record.durationMinutes === null
                ? modalityText(record.modality)
                : `${modalityText(record.modality)}, ${durationText(record.durationMinutes)}`}
            </td>
          </tr>
          {record.slotStart === null || record.slotEnd === null ? null : (
            <tr>
              <th scope="row">Time</th>
              <td>{`${utcText(record.slotStart)} to ${utcText(record.slotEnd)}`}</td>
            </tr>
          )}
          <tr>
            <th scope="row">Requested</th>
            <td>{utcText(record.createdAt)}</td>
          </tr>
          {record.responseDeadline === null ? null : (
            <tr>
              <th scope="row">Response deadline</th>
              <td>{utcText(record.responseDeadline)}</td>
            </tr>
          )}
          {record.quoteValidUntil === null ? null : (
            <tr>
              <th scope="row">Price held until</th>
              <td>{utcText(record.quoteValidUntil)}</td>
            </tr>
          )}
        </tbody>
      </Table>
      {amounts === null ? null : (
        <Table id="request-quote" caption="The price of this request">
          <tbody>
            <tr>
              <th scope="row">Attorney&apos;s price</th>
              <td>{moneyText(amounts.listedPriceMinor, amounts.currency)}</td>
            </tr>
            <tr>
              <th scope="row">Client fee</th>
              <td>{moneyText(amounts.clientFeeMinor, amounts.currency)}</td>
            </tr>
            <tr>
              <th scope="row">Other required fees</th>
              <td>{moneyText(amounts.otherFeeMinor, amounts.currency)}</td>
            </tr>
            <tr>
              <th scope="row">Total</th>
              <td>{moneyText(amounts.totalMinor, amounts.currency)}</td>
            </tr>
          </tbody>
        </Table>
      )}
      {decision !== null && decision.state === "accepted" ? (
        <Stack gap="tight">
          <Heading as="h2" size="md">
            Consultation
          </Heading>
          {decision.consultationState === null ? (
            <Text>{DECISION_CONSULTATION_PENDING}</Text>
          ) : (
            <>
              <Text>{DECISION_ACCEPTED}</Text>
              <Table id="request-consultation" caption="Your consultation">
                <tbody>
                  <tr>
                    <th scope="row">Status</th>
                    <td>
                      {CONSULTATION_STATE_TEXT[decision.consultationState]}
                    </td>
                  </tr>
                  {decision.bookingStart === null ||
                  decision.bookingEnd === null ? null : (
                    <tr>
                      <th scope="row">Time</th>
                      <td>{`${utcText(decision.bookingStart)} to ${utcText(decision.bookingEnd)}`}</td>
                    </tr>
                  )}
                </tbody>
              </Table>
              {decision.consultationId === null ? null : (
                <Cluster>
                  <ButtonLink
                    variant="primary"
                    href={clientConsultationPathFor(decision.consultationId)}
                  >
                    Go to your consultation
                  </ButtonLink>
                </Cluster>
              )}
            </>
          )}
        </Stack>
      ) : null}
      {decision !== null &&
      (decision.endedReason === "declined" ||
        decision.endedReason === "could_not_proceed") ? (
        <Stack gap="tight">
          <Text>
            {decision.endedReason === "declined"
              ? DECISION_DECLINED
              : DECISION_COULD_NOT_PROCEED}
          </Text>
          <Cluster>
            <ButtonLink
              variant="secondary"
              href={`/client/intakes/${decision.intakeId}`}
            >
              {SELECT_AGAIN_LABEL}
            </ButtonLink>
          </Cluster>
        </Stack>
      ) : null}
      {record.message === null ? null : (
        <Stack gap="tight">
          <Heading as="h2" size="md">
            {YOUR_MESSAGE}
          </Heading>
          {record.message.split("\n").map((line, index) => (
            <Text key={index}>{line === "" ? "\u00a0" : line}</Text>
          ))}
        </Stack>
      )}
      <Stack gap="tight">
        <Heading as="h2" size="md">
          Payment
        </Heading>
        {payment === null ? (
          <Alert tone="error" title="Payment status unavailable" role="alert">
            The payment status could not be shown right now. Please try again
            later.
          </Alert>
        ) : (
          <>
            <Text>{PAYMENT_STEP_TEXT[payment.step]}</Text>
            {latest === null ? null : (
              <Table id="request-payment" caption="Latest payment">
                <tbody>
                  <tr>
                    <th scope="row">Status</th>
                    <td>
                      <Status tone={PAYMENT_STATE_LABELS[latest.state].tone}>
                        {PAYMENT_STATE_LABELS[latest.state].label}
                      </Status>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Started</th>
                    <td>{utcText(latest.createdAt)}</td>
                  </tr>
                  {latest.authorizedAt === null ? null : (
                    <tr>
                      <th scope="row">Authorized</th>
                      <td>{utcText(latest.authorizedAt)}</td>
                    </tr>
                  )}
                </tbody>
              </Table>
            )}
            {latest === null ? null : (
              <Cluster>
                <ButtonLink
                  variant="secondary"
                  href={`/client/payments/${latest.id}`}
                >
                  View payment receipt
                </ButtonLink>
              </Cluster>
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
            <Text tone="muted">{PAYMENT_STATUS_NOTE}</Text>
          </>
        )}
      </Stack>
      <Text tone="muted">{SERVER_TIME_NOTE}</Text>
      {view.withdrawable ? <WithdrawRequestForm requestId={record.id} /> : null}
      {BACK}
    </RequestFrame>
  );
}
