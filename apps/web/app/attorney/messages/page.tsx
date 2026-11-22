// The attorney's Message inbox (MVP-001 S11 pass 2B; MBS sections 15 and
// 18.3 "messages").
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell, and the database answers only the attorney's own Consultation
// threads (an approved profile at aal2): the Consultation's state, whether
// messaging is open or read-only as the communication window reports it now,
// the number of Messages and when the latest one was sent. No Message body
// and nothing of the client's identity is shown here; each thread links to
// its Consultation page, which reads the thread and decides every Message
// again. No new message capability is added.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { attorneyConsultationPathFor } from "../../../src/application/consultations.ts";
import { resolveAttorneyThreads } from "../../../src/application/participant-workspaces.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { ATTORNEY_WORKSPACE_SOURCES } from "../../../src/infrastructure/workspaces/workspace-adapter.ts";
import { ATTORNEY_STATE_LABELS } from "../../../src/presentation/consultation-labels.ts";
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
  INBOX_INTRO,
  lastMessageText,
  MESSAGING_STATUS_LABELS,
  messageCountText,
  NO_THREADS,
  TIMES_NOTE,
  utcText,
} from "../../../src/presentation/workspace-labels.ts";
import { AttorneyNavigation } from "../../../src/presentation/workspace-navigation.tsx";
import { requireSteppedUp } from "../../account/gate.ts";

export const metadata: Metadata = {
  title: "Messages",
  robots: { index: false, follow: false },
};

function Frame({ children }: { readonly children: ReactNode }) {
  return (
    <Page density="attorney">
      <Surface emphasis="raised" labelledBy="attorney-messages-title">
        <Stack>
          <Eyebrow>Attorney workspace</Eyebrow>
          <Heading as="h1" size="lg" id="attorney-messages-title">
            Messages
          </Heading>
          {children}
          <AttorneyNavigation current="/attorney/messages" />
        </Stack>
      </Surface>
    </Page>
  );
}

export default async function AttorneyMessagesPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const view = await resolveAttorneyThreads(ATTORNEY_WORKSPACE_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <Frame>
        <Text tone="muted">
          Messages are available only to a signed-in account with attorney
          access.
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
          This account does not have attorney messages.
        </Alert>
      </Frame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "attorney_inbox.unavailable", {
      outcome: view.status,
    });
    return (
      <Frame>
        <Alert tone="error" title="Something went wrong" role="alert">
          Your messages could not be shown right now. Please try again later.
        </Alert>
      </Frame>
    );
  }
  return (
    <Frame>
      <Text tone="muted">{INBOX_INTRO}</Text>
      <Text tone="muted">{TIMES_NOTE}</Text>
      {view.threads.length === 0 ? (
        <Text>{NO_THREADS}</Text>
      ) : (
        <Table id="attorney-threads" caption="Your consultation threads">
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
              const state = ATTORNEY_STATE_LABELS[thread.consultationState];
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
                      href={attorneyConsultationPathFor(thread.consultationId)}
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
    </Frame>
  );
}
