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
// the client may withdraw it; the database decides again. Nothing here shows
// a payment step (S7) or anything of the attorney's side (S8).

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveConsultationRequest } from "../../../../src/application/consultation-request.ts";
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
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
  durationText,
  EXPIRED_NOTE,
  modalityText,
  moneyText,
  REQUEST_PATH_LABELS,
  REQUEST_STATE_LABELS,
  SERVER_TIME_NOTE,
  utcText,
} from "../../../../src/presentation/request-labels.ts";
import { WithdrawRequestForm } from "./forms.tsx";

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
  const state = REQUEST_STATE_LABELS[view.displayState];
  const amounts = record.amounts;
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
      <Text tone="muted">{SERVER_TIME_NOTE}</Text>
      {view.withdrawable ? <WithdrawRequestForm requestId={record.id} /> : null}
      {BACK}
    </RequestFrame>
  );
}
