// The attorney's ledger-derived earnings (MVP-001 S7; Packet S7
// "ledger-derived attorney earnings"; PS section 22.3).
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell, and the database answers the attorney_share ledger entries of the
// attorney's own Requests only (aal2, an approved profile): per payment, what
// was attributed at capture, what refunds reversed and the net, with one
// total per currency (never added across currencies). Nothing is a balance,
// a payout or a settlement, and nothing of a client or an Intake is shown.
// The page reads no route parameter, query, header, or cookie of its own.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveAttorneyEarnings } from "../../../src/application/client-payments.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { EARNINGS_SOURCES } from "../../../src/infrastructure/payments/payment-adapter.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Eyebrow,
  Heading,
  Page,
  Stack,
  Surface,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import {
  EARNINGS_INTRO,
  moneyText,
  utcText,
} from "../../../src/presentation/payment-labels.ts";
import { requireSteppedUp } from "../../account/gate.ts";

export const metadata: Metadata = {
  title: "Earnings",
  robots: { index: false, follow: false },
};

function EarningsFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="attorney">
      <Surface emphasis="raised" labelledBy="attorney-earnings-title">
        <Stack>
          <Eyebrow>Attorney workspace</Eyebrow>
          <Heading as="h1" size="lg" id="attorney-earnings-title">
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
    <ButtonLink variant="tertiary" href="/attorney">
      Back to the attorney workspace
    </ButtonLink>
  </Cluster>
);

export default async function AttorneyEarningsPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const view = await resolveAttorneyEarnings(EARNINGS_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <EarningsFrame title="Sign in to continue">
        <Text tone="muted">
          Earnings are available only to a signed-in account with attorney
          access.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </EarningsFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <EarningsFrame title="Earnings not available">
        <Alert tone="warning" title="No workspace access" role="status">
          This account does not have access to the attorney workspace.
        </Alert>
      </EarningsFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "payments.view_unavailable", {
      route: "/attorney/earnings",
      outcome: view.status,
    });
    return (
      <EarningsFrame title="Earnings unavailable">
        <Alert tone="error" title="Something went wrong" role="alert">
          Your earnings could not be shown right now. Please try again later.
        </Alert>
        {BACK}
      </EarningsFrame>
    );
  }
  return (
    <EarningsFrame title="Earnings">
      <Text tone="muted">{EARNINGS_INTRO}</Text>
      {view.lines.length === 0 ? (
        <Text>There are no ledger entries for your requests yet.</Text>
      ) : (
        <>
          <Table id="earnings-totals" caption="Totals by currency">
            <thead>
              <tr>
                <th scope="col">Currency</th>
                <th scope="col">Attributed</th>
                <th scope="col">Reversed by refunds</th>
                <th scope="col">Net</th>
              </tr>
            </thead>
            <tbody>
              {view.totals.map((total) => (
                <tr key={total.currency}>
                  <td>{total.currency}</td>
                  <td>{moneyText(total.attributedMinor, total.currency)}</td>
                  <td>{moneyText(total.reversedMinor, total.currency)}</td>
                  <td>{moneyText(total.netMinor, total.currency)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Table id="earnings-lines" caption="By payment">
            <thead>
              <tr>
                <th scope="col">Collected</th>
                <th scope="col">Attributed</th>
                <th scope="col">Reversed by refunds</th>
                <th scope="col">Net</th>
              </tr>
            </thead>
            <tbody>
              {view.lines.map((line) => (
                <tr key={line.paymentId}>
                  <td>
                    {line.capturedAt === null
                      ? "Not shown"
                      : utcText(line.capturedAt)}
                  </td>
                  <td>{moneyText(line.attributedMinor, line.currency)}</td>
                  <td>{moneyText(line.reversedMinor, line.currency)}</td>
                  <td>{moneyText(line.netMinor, line.currency)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
      {BACK}
    </EarningsFrame>
  );
}
