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
// an entitlement or a settlement.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveClientPayments } from "../../../src/application/participant-workspaces.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { CLIENT_WORKSPACE_SOURCES } from "../../../src/infrastructure/workspaces/workspace-adapter.ts";
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
} from "../../../src/presentation/design-system.tsx";
import {
  PAYMENT_STATE_LABELS,
  PAYMENT_STATUS_NOTE,
} from "../../../src/presentation/payment-labels.ts";
import {
  moneyText,
  NO_PAYMENTS,
  PAYMENTS_INTRO,
  refundText,
  TIMES_NOTE,
  utcText,
} from "../../../src/presentation/workspace-labels.ts";
import { ClientNavigation } from "../../../src/presentation/workspace-navigation.tsx";

export const metadata: Metadata = {
  title: "Your payments",
  robots: { index: false, follow: false },
};

function Frame({ children }: { readonly children: ReactNode }) {
  return (
    <Page density="client">
      <Surface emphasis="raised" labelledBy="payments-title">
        <Stack>
          <Eyebrow>Client workspace</Eyebrow>
          <Heading as="h1" size="lg" id="payments-title">
            Your payments
          </Heading>
          {children}
          <ClientNavigation current="/client/payments" />
        </Stack>
      </Surface>
    </Page>
  );
}

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
  const { page } = await searchParams;
  const view = await resolveClientPayments(CLIENT_WORKSPACE_SOURCES, page);
  if (view.status === "sign-in-required") {
    return (
      <Frame>
        <Text tone="muted">
          Your payments are available only to their signed-in client.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </Frame>
    );
  }
  if (view.status === "denied") {
    return (
      <Frame>
        <Alert tone="warning" title="Not available" role="status">
          This account does not have client payments.
        </Alert>
      </Frame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "client_payment_history.unavailable", {
      route: "/client/payments",
      outcome: view.status,
    });
    return (
      <Frame>
        <Alert tone="error" title="Something went wrong" role="alert">
          Your payments could not be shown right now. Please try again later.
        </Alert>
      </Frame>
    );
  }
  return (
    <Frame>
      <Text tone="muted">{PAYMENTS_INTRO}</Text>
      <Text tone="muted">{TIMES_NOTE}</Text>
      {view.payments.length === 0 ? (
        <Text>{NO_PAYMENTS}</Text>
      ) : (
        <Table id="client-payments" caption="Your payments">
          <thead>
            <tr>
              <th scope="col">Created</th>
              <th scope="col">State</th>
              <th scope="col">Amount</th>
              <th scope="col">Refund</th>
              <th scope="col">Receipt</th>
            </tr>
          </thead>
          <tbody>
            {view.payments.map((payment) => {
              const state = PAYMENT_STATE_LABELS[payment.state];
              return (
                <tr key={payment.id}>
                  <th scope="row">{utcText(payment.createdAt)}</th>
                  <td>
                    <Status tone={state.tone}>{state.label}</Status>
                  </td>
                  <td>{moneyText(payment.totalMinor, payment.currency)}</td>
                  <td>
                    {refundText(
                      payment.state,
                      payment.refundedMinor,
                      moneyText(payment.refundedMinor, payment.currency),
                    ) ?? "None"}
                  </td>
                  <td>
                    <ButtonLink
                      variant="tertiary"
                      href={`/client/payments/${payment.id}`}
                    >
                      Open the receipt
                    </ButtonLink>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <Text size="small" tone="muted">
        {PAYMENT_STATUS_NOTE}
      </Text>
      {view.pager.page > 1 || view.pager.hasNext ? (
        <Cluster>
          {view.pager.page > 1 ? (
            <ButtonLink
              variant="secondary"
              href={pageHref(view.pager.page - 1)}
            >
              Show newer payments
            </ButtonLink>
          ) : null}
          {view.pager.hasNext ? (
            <ButtonLink
              variant="secondary"
              href={pageHref(view.pager.page + 1)}
            >
              Show older payments
            </ButtonLink>
          ) : null}
        </Cluster>
      ) : null}
    </Frame>
  );
}
