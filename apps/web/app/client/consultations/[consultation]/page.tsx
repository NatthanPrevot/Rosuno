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
import { resolveClientConsultation } from "../../../../src/application/consultations.ts";
import { CLIENT_COMMUNICATION_SOURCES } from "../../../../src/infrastructure/communications/communication-adapter.ts";
import { CLIENT_CONSULTATION_SOURCES } from "../../../../src/infrastructure/consultations/consultation-adapter.ts";
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
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
  Eyebrow,
  Heading,
  Page,
  Stack,
  Status,
  Surface,
  Table,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import {
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

function ConsultationFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="client">
      <Surface emphasis="raised" labelledBy="consultation-title">
        <Stack>
          <Eyebrow>Client workspace</Eyebrow>
          <Heading as="h1" size="lg" id="consultation-title">
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

const BACK = (
  <Cluster>
    <ButtonLink variant="tertiary" href="/client">
      Back to your workspace
    </ButtonLink>
  </Cluster>
);

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
      <ConsultationFrame title="Sign in to continue">
        <Text tone="muted">
          Your consultation is available only to its signed-in client.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </ConsultationFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <ConsultationFrame title="Consultation not available">
        <Alert tone="warning" title="Not available" role="status">
          This account does not have access to this consultation.
        </Alert>
      </ConsultationFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "consultation.view_unavailable", {
      route: "/client/consultations/[consultation]",
      outcome: view.status,
    });
    return (
      <ConsultationFrame title="Consultation unavailable">
        <Alert tone="error" title="Something went wrong" role="alert">
          This consultation could not be shown right now. Please try again
          later.
        </Alert>
        {BACK}
      </ConsultationFrame>
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
    <ConsultationFrame title="Your consultation">
      <Cluster>
        <Status tone={state.tone}>{state.label}</Status>
      </Cluster>
      <Text tone="muted">{WORKSPACE_NOTE}</Text>
      {ended ? <Text>{ENDED_NOTE}</Text> : null}
      {view.waiting ? <Text>{CLIENT_WAITING_NOTE}</Text> : null}
      {!ended && !view.joinable && !view.waiting ? (
        <Text>{view.windowPassed ? WINDOW_PASSED_NOTE : NOT_OPEN_NOTE}</Text>
      ) : null}
      <Table id="client-consultation-details" caption="Consultation details">
        <tbody>
          <tr>
            <th scope="row">Consultation</th>
            <td>
              {record.durationMinutes === null
                ? modalityText(record.modality)
                : `${modalityText(record.modality)}, ${durationText(record.durationMinutes)}`}
            </td>
          </tr>
          <tr>
            <th scope="row">How soon</th>
            <td>{PATH_LABELS[record.path]}</td>
          </tr>
          {record.bookingStart === null || record.bookingEnd === null ? null : (
            <tr>
              <th scope="row">Time</th>
              <td>{`${utcText(record.bookingStart)} to ${utcText(record.bookingEnd)}`}</td>
            </tr>
          )}
          {record.opensAt === null || record.closesAt === null ? null : (
            <tr>
              <th scope="row">Room open</th>
              <td>{`${utcText(record.opensAt)} to ${utcText(record.closesAt)}`}</td>
            </tr>
          )}
          {record.startedAt === null ? null : (
            <tr>
              <th scope="row">Started</th>
              <td>{utcText(record.startedAt)}</td>
            </tr>
          )}
          {record.endedAt === null ? null : (
            <tr>
              <th scope="row">Ended</th>
              <td>{utcText(record.endedAt)}</td>
            </tr>
          )}
          {record.outcomeCode === null ? null : (
            <tr>
              <th scope="row">How it ended</th>
              <td>{COMPLETION_LABELS[record.outcomeCode] ?? "Ended"}</td>
            </tr>
          )}
          {record.mediaState === null ? null : (
            <tr>
              <th scope="row">Consultation room</th>
              <td>{MEDIA_STATE_LABELS[record.mediaState]}</td>
            </tr>
          )}
        </tbody>
      </Table>
      <JoinPanel consultationId={record.id} joinable={view.joinable} />
      <Table id="client-consultation-attendance" caption="Attendance recorded">
        <tbody>
          <tr>
            <th scope="row">You joined</th>
            <td>
              {record.clientJoinedAt === null
                ? "Not yet"
                : utcText(record.clientJoinedAt)}
            </td>
          </tr>
          <tr>
            <th scope="row">The attorney joined</th>
            <td>
              {record.attorneyJoinedAt === null
                ? "Not yet"
                : utcText(record.attorneyJoinedAt)}
            </td>
          </tr>
          <tr>
            <th scope="row">Reconnections</th>
            <td>{String(record.reconnections)}</td>
          </tr>
        </tbody>
      </Table>
      <Text tone="muted">{EVIDENCE_NOTE}</Text>
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
      {BACK}
    </ConsultationFrame>
  );
}
