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
// page's own words that the information is not yet available, and says that
// data requests cannot be made here yet (the amendment that would add them,
// PS-A6, is not adopted): there is no request form.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  DATA_CATEGORIES,
  resolveClientAccount,
} from "../../../src/application/participant-workspaces.ts";
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
  Surface,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import {
  DATA_CATEGORY_LABELS,
  DATA_INTRO,
  DATA_REQUESTS_NOT_AVAILABLE,
  PRIVACY_NOT_AVAILABLE,
} from "../../../src/presentation/workspace-labels.ts";
import { ClientNavigation } from "../../../src/presentation/workspace-navigation.tsx";

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
  const view = await resolveClientAccount(CLIENT_WORKSPACE_SOURCES);
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
      <Alert tone="information" title="Not available yet" role="status">
        {DATA_REQUESTS_NOT_AVAILABLE}
      </Alert>
      <Text>{PRIVACY_NOT_AVAILABLE}</Text>
    </Frame>
  );
}
