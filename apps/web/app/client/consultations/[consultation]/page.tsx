// One of the client's Consultations: the waiting room and the consultation
// room (MVP-001 S9; MBS section 14 "client consultation workspace"; IMP
// section 25; TA sections 46 and 48; DM section 2.4).
//
// Rendered on the server for every request and never indexed. The verified
// client of the request decides access (the client intake sources); the
// route segment only names which of the client's own Consultations to show,
// and another client's, an unknown and a malformed id get the same not-found
// page. The page shows the state the server reports (ready as soon as the
// server reports the window open, even before the transition is recorded:
// the browser never decides it), when the room opens and closes (UTC), the
// start and end, how the consultation ended, and the attendance the room
// recorded. While the consultation is ready inside its window the client is
// in the waiting room (no join form: the database grants the room only once
// the attorney has started); once it is live and the window open, the join
// form is offered and the database decides again on submission. The attorney
// starts and ends the consultation; the client cannot. Nothing of the attorney's contact details
// is shown.
//
// DEV-001: the owner's UI/UX design, the client account's consultation: the
// account navigation, the consultation's card (its time, length, type and
// state), the room panel, the cancellation, review and report actions, the
// design's "More details" and attendance facts, and the Messages and
// documents sections with their existing markup.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  resolveClientCommunication,
  resolveClientDocumentHistory,
  type CommunicationView,
  type HistoryView,
} from "../../../../src/application/consultation-communication.ts";
import { cancellable } from "../../../../src/application/consultation-outcomes.ts";
import { resolveClientConsultation } from "../../../../src/application/consultations.ts";
import { resolveClientReviews } from "../../../../src/application/reviews.ts";
import {
  getShellView,
  type ShellView,
} from "../../../../src/application/shell.ts";
import { CLIENT_COMMUNICATION_SOURCES } from "../../../../src/infrastructure/communications/communication-adapter.ts";
import { CLIENT_REVIEW_SOURCES } from "../../../../src/infrastructure/consultations/completion-adapter.ts";
import { CLIENT_CONSULTATION_SOURCES } from "../../../../src/infrastructure/consultations/consultation-adapter.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../../src/infrastructure/identity/server-session-source.ts";
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
import {
  ClientAccount,
  ClientGate,
  ClientPill,
  ConsultationTile,
  ModalityIcon,
  TIMES_IN_UTC,
  whenText,
} from "../../../../src/presentation/client-account.tsx";
import {
  CLIENT_STATE_LABELS,
  CLIENT_WAITING_NOTE,
  COMPLETION_LABELS,
  durationText,
  ENDED_NOTE,
  EVIDENCE_NOTE,
  MEDIA_STATE_LABELS,
  modalityText,
  NOT_OPEN_NOTE,
  PATH_LABELS,
  utcText,
  WINDOW_PASSED_NOTE,
  WORKSPACE_NOTE,
} from "../../../../src/presentation/consultation-labels.ts";
import {
  byteSizeText,
  CURRENT_VERSION_LABEL,
  currentSharingLabel,
  DOCUMENT_TYPE_LABELS,
  DOCUMENTS_HEADING,
  DOCUMENTS_NOTE,
  EARLIER_VERSION_LABEL,
  HISTORY_CLOSE_LABEL,
  HISTORY_HEADING,
  HISTORY_LINK_LABEL,
  HISTORY_NOTE,
  HISTORY_UNAVAILABLE,
  MESSAGES_HEADING,
  MESSAGES_NOTE,
  messagingNote,
  NO_DOCUMENTS,
  NO_MESSAGES,
  OLDER_DOCUMENTS_NOTE,
  OLDER_MESSAGES_NOTE,
  OLDER_VERSIONS_NOTE,
  senderLabel,
  uploaderLabel,
  VERSION_COLUMN,
  versionSharingLabel,
} from "../../../../src/presentation/communication-labels.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Heading,
  Stack,
  Table,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import { outcomeLabelOf } from "../../../../src/presentation/completion-labels.ts";
import { SitePage } from "../../../../src/presentation/site-chrome.tsx";
import { signOut } from "../../../sign-in/actions.ts";
import {
  CancelPanel,
  DocumentControls,
  DocumentReplace,
  DocumentUpload,
  JoinPanel,
  MessageComposer,
} from "./forms.tsx";

// MVP-001 S10 (PS-A5): one document's version history, read on request for
// this request's own caller (the database answers only the versions the
// caller may know about; unknown and unauthorized ids alike, not available).
// Each version opens only where the database will authorize it; the uploader
// may stop sharing one version without touching the others.
function HistorySection({
  history,
  consultationId,
  prefix,
}: {
  readonly history: HistoryView;
  readonly consultationId: string;
  readonly prefix: string;
}) {
  return (
    <Stack>
      <Heading as="h3" size="sm" id={`${prefix}-history`}>
        {HISTORY_HEADING}
      </Heading>
      {history.status !== "ready" ? (
        <Text tone="muted">{HISTORY_UNAVAILABLE}</Text>
      ) : (
        <>
          <Text tone="muted">{HISTORY_NOTE}</Text>
          {history.olderNotShown ? (
            <Text tone="muted">{OLDER_VERSIONS_NOTE}</Text>
          ) : null}
          <Table id={`${prefix}-versions`} caption="Versions of this document">
            <thead>
              <tr>
                <th scope="col">{VERSION_COLUMN}</th>
                <th scope="col">Document</th>
                <th scope="col">Added by</th>
                <th scope="col">Added (UTC)</th>
                <th scope="col">Sharing</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {history.versions.map((version) => (
                <tr key={version.documentId}>
                  <td>{`${version.versionLabel} (${version.current ? CURRENT_VERSION_LABEL : EARLIER_VERSION_LABEL})`}</td>
                  <td>{`${DOCUMENT_TYPE_LABELS[version.mimeType]}, ${byteSizeText(version.byteSize)}`}</td>
                  <td>{uploaderLabel(version.uploadedBy, version.mine)}</td>
                  <td>{utcText(version.createdAt)}</td>
                  <td>{versionSharingLabel(version.sharing, version.mine)}</td>
                  <td>
                    <DocumentControls
                      consultationId={consultationId}
                      resourceId={version.resourceId}
                      openable={version.accessible}
                      revocable={version.mine && version.sharing === "active"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
      <Cluster>
        <ButtonLink
          variant="tertiary"
          href={`/${prefix}/consultations/${consultationId}#${prefix}-documents-title`}
        >
          {HISTORY_CLOSE_LABEL}
        </ButtonLink>
      </Cluster>
    </Stack>
  );
}

// MVP-001 S10: the participants' Messages and shared documents, read afresh
// for this request (the database answers only this Consultation's own
// participants; the attorney at aal2). The composer and the upload form are
// offered only while the server reports communication open; reading stays
// available after it closes. Each document shows its current version and
// label (PS-A5); its uploader may replace it with a new version while
// communication is open, and a document with earlier versions links to its
// version history.
function CommunicationSection({
  view,
  consultationId,
  prefix,
  history,
}: {
  readonly view: CommunicationView;
  readonly consultationId: string;
  readonly prefix: string;
  readonly history: HistoryView | null;
}) {
  if (view.status !== "ready") {
    return (
      <Alert tone="warning" title="Messages and documents" role="status">
        Messages and documents could not be shown right now. Please try again
        later.
      </Alert>
    );
  }
  const note = messagingNote(view.messaging, view.closesAt, utcText);
  const open = view.messaging === "open";
  return (
    <Stack>
      <Heading as="h2" size="md" id={`${prefix}-messages-title`}>
        {MESSAGES_HEADING}
      </Heading>
      <Text tone="muted">{MESSAGES_NOTE}</Text>
      {note === null ? null : <Text>{note}</Text>}
      {view.olderMessagesNotShown ? (
        <Text tone="muted">{OLDER_MESSAGES_NOTE}</Text>
      ) : null}
      {view.messages.length === 0 ? (
        <Text tone="muted">{NO_MESSAGES}</Text>
      ) : (
        <Table
          id={`${prefix}-messages`}
          caption="Messages in this consultation"
        >
          <thead>
            <tr>
              <th scope="col">From</th>
              <th scope="col">Sent (UTC)</th>
              <th scope="col">Message</th>
            </tr>
          </thead>
          <tbody>
            {view.messages.map((message) => (
              <tr key={message.id}>
                <td>{senderLabel(message.senderRole, message.mine)}</td>
                <td>{utcText(message.sentAt)}</td>
                <td>{message.body}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {open ? <MessageComposer consultationId={consultationId} /> : null}
      <Heading as="h2" size="md" id={`${prefix}-documents-title`}>
        {DOCUMENTS_HEADING}
      </Heading>
      <Text tone="muted">{DOCUMENTS_NOTE}</Text>
      {view.olderDocumentsNotShown ? (
        <Text tone="muted">{OLDER_DOCUMENTS_NOTE}</Text>
      ) : null}
      {view.documents.length === 0 ? (
        <Text tone="muted">{NO_DOCUMENTS}</Text>
      ) : (
        <Table
          id={`${prefix}-documents`}
          caption="Documents in this consultation"
        >
          <thead>
            <tr>
              <th scope="col">Document</th>
              <th scope="col">{VERSION_COLUMN}</th>
              <th scope="col">Added by</th>
              <th scope="col">Added (UTC)</th>
              <th scope="col">Sharing</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {view.documents.map((document) => (
              <tr key={document.lineageId}>
                <td>{`${DOCUMENT_TYPE_LABELS[document.mimeType]}, ${byteSizeText(document.byteSize)}`}</td>
                <td>{document.versionLabel}</td>
                <td>{uploaderLabel(document.uploadedBy, document.mine)}</td>
                <td>{utcText(document.createdAt)}</td>
                <td>
                  {currentSharingLabel(
                    document.sharing,
                    document.mine,
                    document.earlierShared,
                  )}
                </td>
                <td>
                  <DocumentControls
                    consultationId={consultationId}
                    resourceId={document.resourceId}
                    openable={document.accessible}
                    revocable={document.mine && document.sharing === "active"}
                  />
                  {document.versionLabel === "v1" ? null : (
                    <Cluster>
                      <ButtonLink
                        variant="tertiary"
                        href={`/${prefix}/consultations/${consultationId}?history=${document.documentId}#${prefix}-history`}
                      >
                        {HISTORY_LINK_LABEL}
                      </ButtonLink>
                    </Cluster>
                  )}
                  {open && document.mine ? (
                    <DocumentReplace
                      consultationId={consultationId}
                      documentId={document.documentId}
                    />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {history === null ? null : (
        <HistorySection
          history={history}
          consultationId={consultationId}
          prefix={prefix}
        />
      )}
      {open ? <DocumentUpload consultationId={consultationId} /> : null}
    </Stack>
  );
}

export const metadata: Metadata = {
  title: "Your consultation",
  robots: { index: false, follow: false },
};

// DEV-001: the account frame for this consultation, with the way back to the
// list.
function ConsultationFrame({
  session,
  children,
}: {
  readonly session: ShellView["session"];
  readonly children: ReactNode;
}) {
  return (
    <SitePage session={session} signOut={signOut}>
      <ClientAccount area="consultations" heading="Your consultation">
        <a className="link sm" href="/client/consultations">
          ← All consultations
        </a>
        {children}
      </ClientAccount>
    </SitePage>
  );
}

// One fact of the design's "More details" and attendance lists.
function Fact({
  term,
  children,
}: {
  readonly term: string;
  readonly children: ReactNode;
}) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// MVP-001 S11: whether the client may still review this completed
// Consultation (the database lists it without a review); the database decides
// again on submission.
async function reviewable(consultationId: string): Promise<boolean> {
  const reviews = await resolveClientReviews(CLIENT_REVIEW_SOURCES);
  return (
    reviews.status === "ready" &&
    reviews.consultations.some(
      (entry) =>
        entry.consultationId === consultationId && entry.review === null,
    )
  );
}

export default async function ClientConsultationPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly consultation: string }>;
  // MVP-001 S10 (PS-A5): only which document's version history to show.
  readonly searchParams: Promise<{
    readonly history?: string | readonly string[];
  }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const shell = await getShellView(SUPABASE_SERVER_SESSION_SOURCE);
  const { consultation } = await params;
  const { history } = await searchParams;
  const historyId = typeof history === "string" ? history : null;
  const view = await resolveClientConsultation(
    CLIENT_CONSULTATION_SOURCES,
    consultation,
  );
  if (view.status === "not-found") {
    notFound();
  }
  if (view.status === "sign-in-required") {
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Sign in to continue">
          <p className="sm muted">
            Your consultation is available only to its signed-in client.
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
        <ClientGate heading="Consultation not available">
          <Alert tone="warning" title="Not available" role="status">
            This account does not have access to this consultation.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "consultation.view_unavailable", {
      route: "/client/consultations/[consultation]",
      outcome: view.status,
    });
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Consultation unavailable">
          <Alert tone="error" title="Something went wrong" role="alert">
            This consultation could not be shown right now. Please try again
            later.
          </Alert>
          <a className="link sm" href="/client/consultations">
            ← All consultations
          </a>
        </ClientGate>
      </SitePage>
    );
  }
  const record = view.consultation;
  const state = CLIENT_STATE_LABELS[view.displayState];
  const ended = [
    "completed",
    "cancelled",
    "no_show",
    "technical_failure",
  ].includes(record.state);
  return (
    <ConsultationFrame session={shell.session}>
      <section
        className="cx-card l-mt12-p22-24 rz-cx-panel"
        aria-labelledby="consultation-when"
      >
        <div className="row between l-g12-fwrwrap-aiflex-start">
          <div className="row l-g14">
            <ConsultationTile modality={record.modality} />
            <div className="stack l-g2-minw0">
              <h2 className="h4" id="consultation-when">
                {record.bookingStart === null
                  ? PATH_LABELS[record.path]
                  : whenText(record.bookingStart)}
              </h2>
              <p className="xs subtle cux-ty l-dflex">
                {record.durationMinutes === null
                  ? null
                  : `${durationText(record.durationMinutes)} · `}
                <ModalityIcon modality={record.modality} />
                <span>{modalityText(record.modality)}</span>
              </p>
            </div>
          </div>
          <ClientPill tone={state.tone}>{state.label}</ClientPill>
        </div>
        <div className="stack l-g4">
          {ended ? <p className="sm">{ENDED_NOTE}</p> : null}
          {view.waiting ? <p className="sm">{CLIENT_WAITING_NOTE}</p> : null}
          {!ended && !view.joinable && !view.waiting ? (
            <p className="sm">
              {view.windowPassed ? WINDOW_PASSED_NOTE : NOT_OPEN_NOTE}
            </p>
          ) : null}
          <p className="xs subtle">{WORKSPACE_NOTE}</p>
        </div>
        <JoinPanel consultationId={record.id} joinable={view.joinable} />
        <CancelPanel
          consultationId={record.id}
          cancellable={cancellable(record.state)}
        />
        <div className="row rz-cluster">
          {record.state === "completed" && (await reviewable(record.id)) ? (
            <a
              className="btn btn-line btn-sm"
              href={`/client/reviews#review-${record.id}`}
            >
              Leave a review
            </a>
          ) : null}
          <a
            className="btn btn-line btn-sm"
            href={`/client/complaints?consultation=${record.id}`}
          >
            Report a problem
          </a>
        </div>
      </section>
      <section
        className="cx-card l-mt12-p18-22"
        aria-labelledby="consultation-more"
      >
        <div className="row between l-g12-aibaseline-fwrwrap">
          <h2 className="cx-dl" id="consultation-more">
            More details
          </h2>
          <span className="xs subtle">{TIMES_IN_UTC}</span>
        </div>
        <dl className="cux-more l-mt10">
          <Fact term="How soon">{PATH_LABELS[record.path]}</Fact>
          {record.bookingStart === null || record.bookingEnd === null ? null : (
            <Fact term="Time">{`${whenText(record.bookingStart)} to ${whenText(record.bookingEnd)}`}</Fact>
          )}
          {record.opensAt === null || record.closesAt === null ? null : (
            <Fact term="Room open">{`${whenText(record.opensAt)} to ${whenText(record.closesAt)}`}</Fact>
          )}
          {record.startedAt === null ? null : (
            <Fact term="Started">{whenText(record.startedAt)}</Fact>
          )}
          {record.endedAt === null ? null : (
            <Fact term="Ended">{whenText(record.endedAt)}</Fact>
          )}
          {record.outcomeCode === null ? null : (
            <Fact term="How it ended">
              {outcomeLabelOf(record.outcomeCode) ??
                COMPLETION_LABELS[record.outcomeCode] ??
                "Ended"}
            </Fact>
          )}
          {record.mediaState === null ? null : (
            <Fact term="Consultation room">
              {MEDIA_STATE_LABELS[record.mediaState]}
            </Fact>
          )}
        </dl>
        <h3 className="cx-dl l-mt16">Attendance recorded</h3>
        <dl className="cux-more l-mt10">
          <Fact term="You joined">
            {record.clientJoinedAt === null
              ? "Not yet"
              : whenText(record.clientJoinedAt)}
          </Fact>
          <Fact term="The attorney joined">
            {record.attorneyJoinedAt === null
              ? "Not yet"
              : whenText(record.attorneyJoinedAt)}
          </Fact>
          <Fact term="Reconnections">{String(record.reconnections)}</Fact>
        </dl>
        <p className="xs subtle l-mt10">{EVIDENCE_NOTE}</p>
      </section>
      <section
        className="cx-card cx-pad rz-cx-panel l-mt12"
        aria-label="Messages and documents"
      >
        <CommunicationSection
          view={await resolveClientCommunication(
            CLIENT_COMMUNICATION_SOURCES,
            record.id,
          )}
          consultationId={record.id}
          prefix="client"
          history={
            historyId === null
              ? null
              : await resolveClientDocumentHistory(
                  CLIENT_COMMUNICATION_SOURCES,
                  record.id,
                  historyId,
                )
          }
        />
      </section>
    </ConsultationFrame>
  );
}
