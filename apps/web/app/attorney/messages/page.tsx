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
//
// DEV-001: the owner's UI/UX design (UIUX-HANDOFF-P2 build_p8, the attorney
// workspace Messages): the workspace frame around the design's conversation
// list (one conversation per consultation, with messaging open first) beside
// the conversation panel; each conversation opens its consultation's page,
// where its messages are read and written. A visitor the page does not admit
// sees the design's signed-out panel.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { attorneyConsultationPathFor } from "../../../src/application/consultations.ts";
import {
  resolveAttorneyThreads,
  type MessageThread,
} from "../../../src/application/participant-workspaces.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { ATTORNEY_WORKSPACE_SOURCES } from "../../../src/infrastructure/workspaces/workspace-adapter.ts";
import {
  AttorneyGate,
  AttorneyWorkspace,
  Pill,
} from "../../../src/presentation/attorney-workspace.tsx";
import { ATTORNEY_STATE_LABELS } from "../../../src/presentation/consultation-labels.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
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
import { requireSteppedUp } from "../../account/gate.ts";

export const metadata: Metadata = {
  title: "Messages",
  robots: { index: false, follow: false },
};

function GateFrame({ children }: { readonly children: ReactNode }) {
  return (
    <AttorneyGate titleId="attorney-messages-title" title="Messages">
      {children}
    </AttorneyGate>
  );
}

// One consultation's conversation in the design's list row.
function ThreadRow({ thread }: { readonly thread: MessageThread }) {
  const state = ATTORNEY_STATE_LABELS[thread.consultationState];
  const messaging = MESSAGING_STATUS_LABELS[thread.messaging];
  return (
    <a
      className="w-th"
      href={attorneyConsultationPathFor(thread.consultationId)}
    >
      <span className="ini" aria-hidden="true">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 5h16v11H8l-4 4z" />
        </svg>
      </span>
      <span className="col grow l-g1-minw0">
        <span className="row between l-g6">
          <span className="sm b ell">{`${state.label} consultation`}</span>
          <Pill tone={messaging.tone}>{messaging.label}</Pill>
        </span>
        <span className="xs muted aw-wraps">
          {`${messageCountText(thread.messageCount)}. ${lastMessageText(thread.lastMessageAt, thread.lastMessageMine, utcText)}`}
        </span>
      </span>
    </a>
  );
}

export default async function AttorneyMessagesPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const view = await resolveAttorneyThreads(ATTORNEY_WORKSPACE_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <GateFrame>
        <Text tone="muted">
          Messages are available only to a signed-in account with attorney
          access.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </GateFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <GateFrame>
        <Alert tone="warning" title="Not available" role="status">
          This account does not have attorney messages.
        </Alert>
      </GateFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "attorney_inbox.unavailable", {
      outcome: view.status,
    });
    return (
      <GateFrame>
        <Alert tone="error" title="Something went wrong" role="alert">
          Your messages could not be shown right now. Please try again later.
        </Alert>
      </GateFrame>
    );
  }
  const open = view.threads.filter((thread) => thread.messaging === "open");
  const other = view.threads.filter((thread) => thread.messaging !== "open");
  return (
    <AttorneyWorkspace
      section="messages"
      titleId="attorney-messages-title"
      title="Messages"
      width="wide"
    >
      <div className="w-msggrid aw-msggrid">
        <section className="w-box w-mlist" aria-label="Conversations">
          {open.length === 0 ? null : (
            <>
              <p className="w-grp">Messaging open</p>
              {open.map((thread) => (
                <ThreadRow key={thread.consultationId} thread={thread} />
              ))}
            </>
          )}
          {other.length === 0 ? null : (
            <>
              <p className="w-grp">Read-only or not available</p>
              {other.map((thread) => (
                <ThreadRow key={thread.consultationId} thread={thread} />
              ))}
            </>
          )}
          {view.threads.length === 0 ? (
            <div className="w-empty">
              <p className="sm b">{NO_THREADS}</p>
              <p className="xs muted">
                A conversation opens when you accept a request.
              </p>
            </div>
          ) : null}
          <p className="xs subtle w-mfoot">
            Clients can only message you inside an accepted consultation.
          </p>
        </section>
        <section className="w-box w-mthread" aria-label="Conversation">
          <div className="w-empty">
            <p className="sm b">Choose a conversation</p>
            <p className="xs muted">{INBOX_INTRO}</p>
            <p className="xs subtle">{TIMES_NOTE}</p>
          </div>
        </section>
      </div>
    </AttorneyWorkspace>
  );
}
