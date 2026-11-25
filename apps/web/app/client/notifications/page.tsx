// The client's notification center (MVP-001 S10; MBS section 15 deliverable
// 12C "user-facing notification/status surfaces"; MB section 98).
//
// Rendered on the server for every request and never indexed. The verified
// client of the request decides access (the client intake sources); the
// database answers only the client's own in-app Notifications, newest first,
// each with its link (the client's own Request or Consultation page, or,
// MVP-001 S11 correction D14, the client's own reported problems page) and
// the delivery state of its email twin. Nothing about an address or a provider is
// shown. An acknowledgement-required Notification offers the acknowledge
// form; the database decides again on submission. DEV-001: the owner's UI/UX
// design places the notification center in the client account's Settings,
// Notifications, with the table's existing markup; the design's notification
// preferences have no record yet and show its "Not available yet" state.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  resolveClientNotifications,
  type CenterEntry,
} from "../../../src/application/notification-center.ts";
import { getShellView } from "../../../src/application/shell.ts";
import { CLIENT_CENTER_SOURCES } from "../../../src/infrastructure/communications/communication-adapter.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../src/infrastructure/identity/server-session-source.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import {
  ClientAccount,
  ClientGate,
  ClientSettings,
  NotAvailableYet,
} from "../../../src/presentation/client-account.tsx";
import {
  CENTER_INTRO,
  CENTER_TITLE,
  EMAIL_STATE_LABELS,
  NO_NOTIFICATIONS,
  NOTIFICATION_LABELS,
  OPEN_NOTIFICATION_LABEL,
  utcText,
} from "../../../src/presentation/communication-labels.ts";
import {
  Alert,
  ButtonLink,
  Stack,
  Status,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { SitePage } from "../../../src/presentation/site-chrome.tsx";
import { signOut } from "../../sign-in/actions.ts";
import { AcknowledgeForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Notifications",
  robots: { index: false, follow: false },
};

function CenterTable({
  entries,
  prefix,
}: {
  readonly entries: readonly CenterEntry[];
  readonly prefix: string;
}) {
  if (entries.length === 0) {
    return <Text tone="muted">{NO_NOTIFICATIONS}</Text>;
  }
  return (
    <Table id={`${prefix}-notifications`} caption="Your notifications">
      <thead>
        <tr>
          <th scope="col">Notification</th>
          <th scope="col">Received (UTC)</th>
          <th scope="col">Email</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.id}>
            <td>
              {entry.critical ? (
                <Status tone="warning">Important</Status>
              ) : null}{" "}
              {NOTIFICATION_LABELS[entry.type]}
            </td>
            <td>{utcText(entry.createdAt)}</td>
            <td>
              {entry.emailState === null
                ? "No email"
                : EMAIL_STATE_LABELS[entry.emailState]}
            </td>
            <td>
              <Stack gap="tight">
                {entry.linkPath === null ? null : (
                  <ButtonLink variant="tertiary" href={entry.linkPath}>
                    {OPEN_NOTIFICATION_LABEL}
                  </ButtonLink>
                )}
                {entry.acknowledgementRequired &&
                entry.state !== "acknowledged" ? (
                  <AcknowledgeForm notificationId={entry.id} />
                ) : null}
                {entry.state === "acknowledged" ? (
                  <Text size="small">Acknowledged</Text>
                ) : null}
              </Stack>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export default async function ClientNotificationsPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const shell = await getShellView(SUPABASE_SERVER_SESSION_SOURCE);
  const view = await resolveClientNotifications(CLIENT_CENTER_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Sign in to continue">
          <p className="sm muted">
            Notifications are available only to signed-in client accounts.
          </p>
          <a className="btn btn-ink" href="/sign-in">
            Sign in
          </a>
        </ClientGate>
      </SitePage>
    );
  }
  if (view.status === "denied") {
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Notifications not available">
          <Alert tone="warning" title="Not available" role="status">
            This account does not have access to client notifications.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "notification.view_unavailable", {
      route: "/client/notifications",
      outcome: view.status,
    });
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Notifications unavailable">
          <Alert tone="error" title="Something went wrong" role="alert">
            Your notifications could not be shown right now. Please try again
            later.
          </Alert>
          <a className="cx-link" href="/client">
            Back to your account
          </a>
        </ClientGate>
      </SitePage>
    );
  }
  return (
    <SitePage session={shell.session} signOut={signOut}>
      <ClientAccount area="settings" heading="Settings">
        <ClientSettings category="notifications" labelledBy="cx-set-h">
          <div className="rz-cx-panel">
            <h2 className="cx-ct2" id="cx-set-h">
              {CENTER_TITLE}
            </h2>
            <Text tone="muted">{CENTER_INTRO}</Text>
            <CenterTable entries={view.entries} prefix="client" />
          </div>
          <p className="cx-sgrp">Notification preferences</p>
          <NotAvailableYet
            reason="choosing which notifications you receive, and how, is not part of your account yet."
            placeholder="[notification channels and wording — per communications policy]"
          />
        </ClientSettings>
      </ClientAccount>
    </SitePage>
  );
}
