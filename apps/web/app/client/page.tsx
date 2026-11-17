// Protected client workspace (P5-001).
//
// Rendered on the server for every request: the trusted server session, the
// trusted client principal source and the Security Shell decide access, and
// the client's own Intakes are read through the request's own session under
// the database's row policies. The one query value read, page, only asks
// which page of the client's own Intakes to show (newest first); the server
// checks it and shows the first page for anything else. The page reads no
// route parameter, header, cookie, or form field of its own. When a page
// does not hold every Intake, it says so and links to its neighbours, so no
// Intake is left out unseen. Refused and unavailable requests each see one
// fixed message and no Intake data; an unavailable workspace also writes one
// log line with no client or Intake data.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveClientWorkspace } from "../../src/application/client-intake.ts";
import { CLIENT_INTAKE_SOURCES } from "../../src/infrastructure/client/client-intake-adapter.ts";
import { logRequestEvent } from "../../src/infrastructure/observability/request-log.ts";
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

function pageHref(page: number): string {
  return page === 1 ? "/client" : `/client?page=${page}`;
}

export default async function ClientWorkspacePage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string | string[] }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const { page } = await searchParams;
  const view = await resolveClientWorkspace(CLIENT_INTAKE_SOURCES, page);
  if (view.status === "ready") {
    const first = (view.page - 1) * view.pageSize + 1;
    const last = first + view.intakes.length - 1;
    return (
      <WorkspaceFrame title="Your Intakes">
        <Text tone="muted">
          An Intake keeps what you tell us about your legal matter. Every time
          you save, a new version is kept; earlier versions are never changed or
          deleted.
        </Text>
        {view.intakes.length === 0 && view.page === 1 ? (
          <Text>You have not started an Intake yet.</Text>
        ) : null}
        {view.intakes.length === 0 && view.page > 1 ? (
          <>
            <Text>There are no Intakes on this page.</Text>
            <Cluster>
              <ButtonLink variant="secondary" href="/client">
                Show your most recent Intakes
              </ButtonLink>
            </Cluster>
          </>
        ) : null}
        {view.intakes.length === 0 ? null : (
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
        {view.intakes.length > 0 &&
        (view.newerPage !== null || view.olderPage !== null) ? (
          <>
            <Text tone="muted">
              {`Showing Intakes ${first} to ${last}, newest first.`}
              {view.olderPage === null
                ? " There are no older Intakes."
                : " Older Intakes are on the next page."}
            </Text>
            <Cluster>
              {view.newerPage === null ? null : (
                <ButtonLink variant="secondary" href={pageHref(view.newerPage)}>
                  Show newer Intakes
                </ButtonLink>
              )}
              {view.olderPage === null ? null : (
                <ButtonLink variant="secondary" href={pageHref(view.olderPage)}>
                  Show older Intakes
                </ButtonLink>
              )}
            </Cluster>
          </>
        ) : null}
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
  await logRequestEvent("warn", "client_workspace.unavailable", {
    route: "/client",
    outcome: view.status,
  });
  return (
    <WorkspaceFrame title="Client workspace unavailable">
      <Alert tone="error" title="Something went wrong" role="alert">
        Your workspace could not be shown. Please try again later.
      </Alert>
    </WorkspaceFrame>
  );
}
