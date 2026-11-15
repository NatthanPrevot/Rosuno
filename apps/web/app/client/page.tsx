// Protected client workspace (P5-001).
//
// Rendered on the server for every request: the trusted server session, the
// trusted client principal source and the Security Shell decide access, and
// the client's own Intakes are read through the request's own session under
// the database's row policies. The page reads no route parameter, query,
// header, cookie, or form field of its own. Refused and unavailable requests
// each see one fixed message and no Intake data.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveClientWorkspace } from "../../src/application/client-intake.ts";
import { CLIENT_INTAKE_SOURCES } from "../../src/infrastructure/client/client-intake-adapter.ts";
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
} from "../../src/presentation/design-system.tsx";
import { INTAKE_STATE_LABELS } from "../../src/presentation/client-intake-labels.ts";
import { StartIntakeForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Client workspace",
  robots: { index: false, follow: false },
};

function WorkspaceFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="client">
      <Surface emphasis="raised" labelledBy="client-workspace-title">
        <Stack>
          <Eyebrow>Client workspace</Eyebrow>
          <Heading as="h1" size="lg" id="client-workspace-title">
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

function dateTime(timestamp: string): string {
  return `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export default async function ClientWorkspacePage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const view = await resolveClientWorkspace(CLIENT_INTAKE_SOURCES);
  if (view.status === "ready") {
    return (
      <WorkspaceFrame title="Your Intakes">
        <Text tone="muted">
          An Intake keeps what you tell us about your legal matter. Every time
          you save, a new version is kept; earlier versions are never changed or
          deleted.
        </Text>
        {view.intakes.length === 0 ? (
          <Text>You have not started an Intake yet.</Text>
        ) : (
          <Table id="client-intakes" caption="Your Intakes">
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">State</th>
                <th scope="col">Last saved</th>
                <th scope="col">Open</th>
              </tr>
            </thead>
            <tbody>
              {view.intakes.map((intake) => (
                <tr key={intake.id}>
                  <th scope="row">{dateTime(intake.createdAt)}</th>
                  <td>
                    <Status tone={INTAKE_STATE_LABELS[intake.state].tone}>
                      {INTAKE_STATE_LABELS[intake.state].label}
                    </Status>
                  </td>
                  <td>
                    {intake.lastSavedAt === null
                      ? "Not saved yet"
                      : `${dateTime(intake.lastSavedAt)} (version ${intake.revisions})`}
                  </td>
                  <td>
                    <ButtonLink
                      variant="tertiary"
                      href={`/client/intakes/${intake.id}`}
                    >
                      Open
                    </ButtonLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {view.canStart ? (
          <StartIntakeForm />
        ) : (
          <Alert tone="information" title="Intake is not available yet">
            New Intakes cannot be started right now. Please come back later.
          </Alert>
        )}
        <Cluster>
          <ButtonLink variant="tertiary" href="/">
            Return to the home page
          </ButtonLink>
        </Cluster>
      </WorkspaceFrame>
    );
  }
  if (view.status === "sign-in-required") {
    return (
      <WorkspaceFrame title="Sign in to continue">
        <Text>Sign in to see your Intakes.</Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </WorkspaceFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <WorkspaceFrame title="Client workspace unavailable">
        <Alert tone="error" title="Not available for this account" role="alert">
          The client workspace is available to signed-in client accounts.
        </Alert>
        <Cluster>
          <ButtonLink variant="tertiary" href="/">
            Return to the home page
          </ButtonLink>
        </Cluster>
      </WorkspaceFrame>
    );
  }
  return (
    <WorkspaceFrame title="Client workspace unavailable">
      <Alert tone="error" title="Something went wrong" role="alert">
        Your workspace could not be shown. Please try again later.
      </Alert>
    </WorkspaceFrame>
  );
}
