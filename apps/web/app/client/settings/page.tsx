// The client's profile and settings (MVP-001 S11 pass 2B; MBS section 18.2
// "profile / settings").
//
// Rendered on the server for every request and never indexed. The verified
// client of the request decides access (the client intake sources); the
// database answers the client's own account: the display name, the account
// state and since when the account exists. No database function lets a
// client change the display name, so nothing here changes anything. Sign-in
// security for a client account is its password: the page says where the
// existing password reset starts (the sign-in page) and links the
// notification center. The authenticator setup page serves attorney and
// staff accounts only, so it is not linked here.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveClientAccount } from "../../../src/application/participant-workspaces.ts";
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
  ACCOUNT_STATE_LABELS,
  NO_DISPLAY_NAME,
  SETTINGS_INTRO,
  SIGN_IN_SECURITY_NOTE,
  utcText,
} from "../../../src/presentation/workspace-labels.ts";
import { ClientNavigation } from "../../../src/presentation/workspace-navigation.tsx";

export const metadata: Metadata = {
  title: "Profile and settings",
  robots: { index: false, follow: false },
};

function Frame({ children }: { readonly children: ReactNode }) {
  return (
    <Page density="client">
      <Surface emphasis="raised" labelledBy="settings-title">
        <Stack>
          <Eyebrow>Client workspace</Eyebrow>
          <Heading as="h1" size="lg" id="settings-title">
            Profile and settings
          </Heading>
          {children}
          <ClientNavigation current="/client/settings" />
        </Stack>
      </Surface>
    </Page>
  );
}

export default async function ClientSettingsPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const view = await resolveClientAccount(CLIENT_WORKSPACE_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <Frame>
        <Text tone="muted">
          Your settings are available only to their signed-in client.
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
          This account does not have client settings.
        </Alert>
      </Frame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "client_settings.unavailable", {
      route: "/client/settings",
      outcome: view.status,
    });
    return (
      <Frame>
        <Alert tone="error" title="Something went wrong" role="alert">
          Your settings could not be shown right now. Please try again later.
        </Alert>
      </Frame>
    );
  }
  const state = ACCOUNT_STATE_LABELS[view.account.accountState];
  return (
    <Frame>
      <Text tone="muted">{SETTINGS_INTRO}</Text>
      <Table id="client-account" caption="Your account">
        <tbody>
          <tr>
            <th scope="row">Display name</th>
            <td>{view.account.displayName ?? NO_DISPLAY_NAME}</td>
          </tr>
          <tr>
            <th scope="row">Account state</th>
            <td>
              <Status tone={state.tone}>{state.label}</Status>
            </td>
          </tr>
          <tr>
            <th scope="row">Account created</th>
            <td>{utcText(view.account.createdAt)}</td>
          </tr>
        </tbody>
      </Table>
      <Heading as="h2" size="md" id="sign-in-security">
        Sign-in security
      </Heading>
      <Text>{SIGN_IN_SECURITY_NOTE}</Text>
      <Cluster>
        <ButtonLink variant="secondary" href="/client/notifications">
          Notification center
        </ButtonLink>
      </Cluster>
    </Frame>
  );
}
