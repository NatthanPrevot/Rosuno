// The client's privacy and data page (MVP-001 S11 pass 2B; MBS section 18.2
// "privacy / data controls"; MVP-001 Packet rule 11: unapproved legal or
// regulatory text is never rendered).
//
// Rendered on the server for every request and never indexed. The verified
// client of the request decides access (the client intake sources); the
// database answers the counts of the categories of records the client's own
// account holds (Intakes, Requests, Consultations, uploaded documents, sent
// Messages, payment attempts and reported problems), never their content. No
// privacy text is approved yet, so the page repeats only the public privacy
// page's own words that the information is not yet available. PS-A6 section
// 3: the client submits a data request of one type (access, correction,
// deletion, export or restriction) with an optional description, sees their
// own requests with their state and decision, and withdraws one before its
// decision. The wording is neutral and fixed: no statement of rights,
// entitlements, timelines or retention (Packet rule 11).

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveClientDataRequests } from "../../../src/application/data-requests.ts";
import {
  DATA_CATEGORIES,
  resolveClientAccount,
} from "../../../src/application/participant-workspaces.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { CLIENT_DATA_REQUEST_SOURCES } from "../../../src/infrastructure/privacy/privacy-adapter.ts";
import { CLIENT_WORKSPACE_SOURCES } from "../../../src/infrastructure/workspaces/workspace-adapter.ts";
import { utcText } from "../../../src/presentation/completion-labels.ts";
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
  DATA_REQUEST_NOTE,
  OUTCOME_LABELS,
  RECORDED_DECISION_LABEL,
  REQUEST_STATE_LABELS,
  REQUEST_TYPE_LABELS,
} from "../../../src/presentation/privacy-labels.ts";
import {
  DATA_CATEGORY_LABELS,
  DATA_INTRO,
  PRIVACY_NOT_AVAILABLE,
} from "../../../src/presentation/workspace-labels.ts";
import { ClientNavigation } from "../../../src/presentation/workspace-navigation.tsx";
import { DataRequestForm, WithdrawRequestForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Privacy and data",
  robots: { index: false, follow: false },
};

function Frame({ children }: { readonly children: ReactNode }) {
  return (
    <Page density="client">
      <Surface emphasis="raised" labelledBy="data-title">
        <Stack>
          <Eyebrow>Client workspace</Eyebrow>
          <Heading as="h1" size="lg" id="data-title">
            Privacy and data
          </Heading>
          {children}
          <ClientNavigation current="/client/privacy" />
        </Stack>
      </Surface>
    </Page>
  );
}

export default async function ClientDataPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const [view, requests] = await Promise.all([
    resolveClientAccount(CLIENT_WORKSPACE_SOURCES),
    resolveClientDataRequests(CLIENT_DATA_REQUEST_SOURCES),
  ]);
  if (view.status === "sign-in-required") {
    return (
      <Frame>
        <Text tone="muted">
          This page is available only to its signed-in client.
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
          This account does not have a client workspace.
        </Alert>
      </Frame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "client_data.unavailable", {
      route: "/client/privacy",
      outcome: view.status,
    });
    return (
      <Frame>
        <Alert tone="error" title="Something went wrong" role="alert">
          This page could not be shown right now. Please try again later.
        </Alert>
      </Frame>
    );
  }
  return (
    <Frame>
      <Text tone="muted">{DATA_INTRO}</Text>
      <Table id="client-data" caption="Records your account holds">
        <thead>
          <tr>
            <th scope="col">Kind of record</th>
            <th scope="col">Count</th>
          </tr>
        </thead>
        <tbody>
          {DATA_CATEGORIES.map((category) => (
            <tr key={category}>
              <th scope="row">{DATA_CATEGORY_LABELS[category]}</th>
              <td>{view.account.counts[category]}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Heading as="h2" size="md" id="data-requests-title">
        Requests about your data
      </Heading>
      <Text tone="muted">{DATA_REQUEST_NOTE}</Text>
      <DataRequestForm />
      {requests.status !== "ready" ? (
        <Alert tone="error" title="Something went wrong" role="alert">
          Your requests could not be shown right now. Please try again later.
        </Alert>
      ) : requests.requests.length === 0 ? (
        <Text>You have not made a request about your data.</Text>
      ) : (
        requests.requests.map((request) => (
          <Surface key={request.id} labelledBy={`data-request-${request.id}`}>
            <Stack gap="tight">
              <Heading as="h3" size="sm" id={`data-request-${request.id}`}>
                {`${REQUEST_TYPE_LABELS[request.type]}, submitted ${utcText(request.submittedAt)}`}
              </Heading>
              <Cluster>
                <Status tone={REQUEST_STATE_LABELS[request.state].tone}>
                  {REQUEST_STATE_LABELS[request.state].label}
                </Status>
                {request.outcome === null ? null : (
                  <Status tone="neutral">
                    {`${RECORDED_DECISION_LABEL}: ${OUTCOME_LABELS[request.outcome]}`}
                  </Status>
                )}
              </Cluster>
              {request.details === null ? null : (
                <Text size="small">{`Your details: ${request.details}`}</Text>
              )}
              {request.decidedAt === null ? null : (
                <Text size="small" tone="muted">
                  {`Decided ${utcText(request.decidedAt)}`}
                </Text>
              )}
              {request.state === "submitted" ||
              request.state === "in_review" ? (
                <WithdrawRequestForm request={request.id} />
              ) : null}
            </Stack>
          </Surface>
        ))
      )}
      <Text>{PRIVACY_NOT_AVAILABLE}</Text>
    </Frame>
  );
}
