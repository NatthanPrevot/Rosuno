// The client's Message inbox (MVP-001 S11 pass 2B; MBS sections 15 and 18.2
// "messages").
//
// Rendered on the server for every request and never indexed. The verified
// client of the request decides access (the client intake sources); the
// database answers only the client's own Consultation threads: the
// Consultation's state, whether messaging is open or read-only as the
// communication window reports it now, the number of Messages and when the
// latest one was sent. No Message body is shown here; each thread links to
// its Consultation page, which reads the thread and decides every Message
// again. No new message capability is added. DEV-001: the owner's UI/UX
// design, inside the client account (beside My consultations, which links
// here), with the thread table's existing markup.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveClientThreads } from "../../../src/application/participant-workspaces.ts";
import { getShellView } from "../../../src/application/shell.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../src/infrastructure/identity/server-session-source.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { CLIENT_WORKSPACE_SOURCES } from "../../../src/infrastructure/workspaces/workspace-adapter.ts";
import {
  ClientAccount,
  ClientGate,
} from "../../../src/presentation/client-account.tsx";
import { CLIENT_STATE_LABELS } from "../../../src/presentation/consultation-labels.ts";
import {
  Alert,
  ButtonLink,
  Status,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { SitePage } from "../../../src/presentation/site-chrome.tsx";
import {
  INBOX_INTRO,
  lastMessageText,
  MESSAGING_STATUS_LABELS,
  messageCountText,
  NO_THREADS,
  TIMES_NOTE,
  utcText,
} from "../../../src/presentation/workspace-labels.ts";
import { signOut } from "../../sign-in/actions.ts";

export const metadata: Metadata = {
  title: "Your messages",
  robots: { index: false, follow: false },
};

export default async function ClientMessagesPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const shell = await getShellView(SUPABASE_SERVER_SESSION_SOURCE);
  const view = await resolveClientThreads(CLIENT_WORKSPACE_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Sign in to continue">
          <p className="sm muted">
            Your messages are available only to their signed-in client.
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
        <ClientGate heading="Your messages">
          <Alert tone="warning" title="Not available" role="status">
            This account does not have client messages.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "client_inbox.unavailable", {
      outcome: view.status,
    });
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Your messages">
          <Alert tone="error" title="Something went wrong" role="alert">
            Your messages could not be shown right now. Please try again later.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  return (
    <SitePage session={shell.session} signOut={signOut}>
      <ClientAccount area="consultations" heading="Your messages">
        <a className="link sm" href="/client/consultations">
          ← My consultations
        </a>
        <section
          className="cx-card cx-pad rz-cx-panel l-mt12"
          aria-label="Your consultation threads"
        >
          <Text tone="muted">{INBOX_INTRO}</Text>
          <Text tone="muted">{TIMES_NOTE}</Text>
          {view.threads.length === 0 ? (
            <Text>{NO_THREADS}</Text>
          ) : (
            <Table id="client-threads" caption="Your consultation threads">
              <thead>
                <tr>
                  <th scope="col">Consultation</th>
                  <th scope="col">Messaging</th>
                  <th scope="col">Messages</th>
                  <th scope="col">Open</th>
                </tr>
              </thead>
              <tbody>
                {view.threads.map((thread) => {
                  const state = CLIENT_STATE_LABELS[thread.consultationState];
                  const messaging = MESSAGING_STATUS_LABELS[thread.messaging];
                  return (
                    <tr key={thread.consultationId}>
                      <th scope="row">
                        <Status tone={state.tone}>{state.label}</Status>
                      </th>
                      <td>
                        <Status tone={messaging.tone}>{messaging.label}</Status>
                      </td>
                      <td>
                        {`${messageCountText(thread.messageCount)}. ${lastMessageText(thread.lastMessageAt, thread.lastMessageMine, utcText)}`}
                      </td>
                      <td>
                        <ButtonLink
                          variant="tertiary"
                          href={`/client/consultations/${thread.consultationId}`}
                        >
                          Open the consultation
                        </ButtonLink>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </section>
      </ClientAccount>
    </SitePage>
  );
}
