// One of the attorney's Consultations: the consultation room, the start and
// the end (MVP-001 S9; MBS section 14 "attorney consultation workspace"; IMP
// section 25; TA sections 46 and 48; DM section 2.4; PM row 20).
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell. The route segment only names which of the attorney's own
// Consultations to show; another attorney's, an unknown and a malformed id
// get the same not-found page. The page shows the state the server reports
// (ready as soon as the server reports the window open, even before the
// transition is recorded: the browser never decides it), when the room opens
// and closes (UTC), the start and end and the attendance the room recorded.
// While the Consultation is ready inside its window, the start form (the room
// is not granted before the start, so a refused start never opens it); once
// it is live and the window open, the join form and the end form (the
// attorney's declaration of normal completion). The
// database decides again on every submission. Nothing of the client's
// identity is shown.
//
// DEV-001: the owner's UI/UX design (UIUX-HANDOFF-P2 build_p8, the attorney
// workspace consultation record): the workspace frame around the design's
// cards: the consultation (its state, time, facts and the existing room,
// start and end, cancellation and early-end panels), the attendance
// recorded, the messages as the design's conversation and the shared
// documents with their existing controls. A visitor the page does not admit
// sees the design's signed-out panel.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  resolveAttorneyCommunication,
  resolveAttorneyDocumentHistory,
  type CommunicationView,
  type HistoryView,
} from "../../../../src/application/consultation-communication.ts";
import {
  cancellable,
  earlyEndOffered,
} from "../../../../src/application/consultation-outcomes.ts";
import { resolveAttorneyConsultation } from "../../../../src/application/consultations.ts";
import { ATTORNEY_COMMUNICATION_SOURCES } from "../../../../src/infrastructure/communications/communication-adapter.ts";
import { ATTORNEY_CONSULTATION_SOURCES } from "../../../../src/infrastructure/consultations/consultation-adapter.ts";
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
import {
  ATTORNEY_READY_NOTE,
  ATTORNEY_STATE_LABELS,
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
  AttorneyGate,
  AttorneyWorkspace,
  Card,
  Facts,
  ModalityTile,
  Pill,
  TIMES_IN_UTC,
  whenText,
} from "../../../../src/presentation/attorney-workspace.tsx";
import {
  Alert,
  ButtonLink,
  Cluster,
  Heading,
  Table,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import { requireSteppedUp } from "../../../account/gate.ts";
import { outcomeLabelOf } from "../../../../src/presentation/completion-labels.ts";
import {
  CommandPanel,
  CompletionPanel,
  DocumentControls,
  DocumentReplace,
  DocumentUpload,
  MessageComposer,
  RoomPanel,
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
    <div className="aw-history">
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
    </div>
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
  // DEV-001: the messages as the design's conversation, then the shared
  // documents, each in its own card.
  const note = messagingNote(view.messaging, view.closesAt, utcText);
  const open = view.messaging === "open";
  return (
    <>
      <Card id={`${prefix}-messages-title`} title={MESSAGES_HEADING}>
        <Text tone="muted">{MESSAGES_NOTE}</Text>
        {note === null ? null : <p className="w-mwin xs">{note}</p>}
        {view.olderMessagesNotShown ? (
          <Text tone="muted">{OLDER_MESSAGES_NOTE}</Text>
        ) : null}
        {view.messages.length === 0 ? (
          <Text tone="muted">{NO_MESSAGES}</Text>
        ) : (
          <ol
            className="w-mcol aw-thread"
            aria-label="Messages in this consultation"
          >
            {view.messages.map((message) => (
              <li
                className={message.mine ? "w-mb me" : "w-mb"}
                key={message.id}
              >
                <p className="sm">{message.body}</p>
                <span className="xs subtle">{`${senderLabel(message.senderRole, message.mine)} · ${utcText(message.sentAt)}`}</span>
              </li>
            ))}
          </ol>
        )}
        {open ? <MessageComposer consultationId={consultationId} /> : null}
      </Card>
      <Card id={`${prefix}-documents-title`} title={DOCUMENTS_HEADING}>
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
      </Card>
    </>
  );
}

export const metadata: Metadata = {
  title: "Consultation",
  robots: { index: false, follow: false },
};

function GateFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <AttorneyGate titleId="attorney-consultation-title" title={title}>
      {children}
    </AttorneyGate>
  );
}

const BACK = (
  <Cluster>
    <ButtonLink variant="tertiary" href="/attorney/consultations">
      All consultations
    </ButtonLink>
  </Cluster>
);

export default async function AttorneyConsultationPage({
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
  await requireSteppedUp("attorney");
  const { consultation } = await params;
  const { history } = await searchParams;
  const historyId = typeof history === "string" ? history : null;
  const view = await resolveAttorneyConsultation(
    ATTORNEY_CONSULTATION_SOURCES,
    consultation,
  );
  if (view.status === "not-found") {
    notFound();
  }
  if (view.status === "sign-in-required") {
    return (
      <GateFrame title="Sign in to continue">
        <Text tone="muted">
          Consultations are available only to a signed-in account with attorney
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
      <GateFrame title="Consultation not available">
        <Alert tone="warning" title="No consultations access" role="status">
          This account does not have access to attorney consultations.
        </Alert>
      </GateFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "consultation.view_unavailable", {
      route: "/attorney/consultations/[consultation]",
      outcome: view.status,
    });
    return (
      <GateFrame title="Consultation unavailable">
        <Alert tone="error" title="Something went wrong" role="alert">
          This consultation could not be shown right now. Please try again
          later.
        </Alert>
        {BACK}
      </GateFrame>
    );
  }
  const record = view.consultation;
  const state = ATTORNEY_STATE_LABELS[view.displayState];
  const ended = [
    "completed",
    "cancelled",
    "no_show",
    "technical_failure",
  ].includes(record.state);
  return (
    <AttorneyWorkspace
      section="consultations"
      titleId="attorney-consultation-title"
      title="Consultation"
      width="medium"
    >
      {BACK}
      <Card
        id="attorney-consultation-summary"
        title={
          record.bookingStart === null
            ? PATH_LABELS[record.path]
            : whenText(record.bookingStart)
        }
      >
        <div className="row between l-g8">
          <Pill tone={state.tone}>{state.label}</Pill>
          <span className="xs subtle">{TIMES_IN_UTC}</span>
        </div>
        <div className="row w-rqhead">
          <ModalityTile modality={record.modality} large />
          <div className="col grow l-g1-minw0">
            <p className="w-rqn">
              {record.durationMinutes === null
                ? modalityText(record.modality)
                : `${modalityText(record.modality)}, ${durationText(record.durationMinutes)}`}
            </p>
            <p className="sm muted">{PATH_LABELS[record.path]}</p>
          </div>
        </div>
        <p className="xs subtle">{WORKSPACE_NOTE}</p>
        {ended ? <p className="w-note info">{ENDED_NOTE}</p> : null}
        {view.startable ? (
          <p className="w-note ok">{ATTORNEY_READY_NOTE}</p>
        ) : null}
        {!ended && !view.joinable && !view.waiting ? (
          <p className="w-note">
            {view.windowPassed ? WINDOW_PASSED_NOTE : NOT_OPEN_NOTE}
          </p>
        ) : null}
        <Facts
          items={[
            [
              "Consultation",
              record.durationMinutes === null
                ? modalityText(record.modality)
                : `${modalityText(record.modality)}, ${durationText(record.durationMinutes)}`,
            ],
            ["How soon", PATH_LABELS[record.path]],
            ...(record.bookingStart === null || record.bookingEnd === null
              ? []
              : ([
                  [
                    "Time",
                    `${utcText(record.bookingStart)} to ${utcText(record.bookingEnd)}`,
                  ],
                ] as const)),
            ...(record.opensAt === null || record.closesAt === null
              ? []
              : ([
                  [
                    "Room open",
                    `${utcText(record.opensAt)} to ${utcText(record.closesAt)}`,
                  ],
                ] as const)),
            ...(record.startedAt === null
              ? []
              : ([["Started", utcText(record.startedAt)]] as const)),
            ...(record.endedAt === null
              ? []
              : ([["Ended", utcText(record.endedAt)]] as const)),
            ...(record.outcomeCode === null
              ? []
              : ([
                  [
                    "How it ended",
                    outcomeLabelOf(record.outcomeCode) ??
                      COMPLETION_LABELS[record.outcomeCode] ??
                      "Ended",
                  ],
                ] as const)),
            ...(record.mediaState === null
              ? []
              : ([
                  ["Consultation room", MEDIA_STATE_LABELS[record.mediaState]],
                ] as const)),
          ]}
        />
        <RoomPanel consultationId={record.id} joinable={view.joinable} />
        <CommandPanel
          consultationId={record.id}
          startable={view.startable}
          endable={view.endable}
        />
        <CompletionPanel
          consultationId={record.id}
          cancellable={cancellable(record.state)}
          endableEarly={earlyEndOffered(record, Date.now())}
        />
        <Cluster>
          <ButtonLink
            variant="tertiary"
            href={`/attorney/complaints?consultation=${record.id}`}
          >
            Report a problem
          </ButtonLink>
        </Cluster>
      </Card>
      <Card id="attorney-consultation-attendance" title="Attendance recorded">
        <Facts
          items={[
            [
              "You joined",
              record.attorneyJoinedAt === null
                ? "Not yet"
                : utcText(record.attorneyJoinedAt),
            ],
            [
              "The client joined",
              record.clientJoinedAt === null
                ? "Not yet"
                : utcText(record.clientJoinedAt),
            ],
            ["Both present together", record.bothPresent ? "Yes" : "No"],
            ["Reconnections", String(record.reconnections)],
          ]}
        />
        <p className="xs subtle">{EVIDENCE_NOTE}</p>
      </Card>
      <CommunicationSection
        view={await resolveAttorneyCommunication(
          ATTORNEY_COMMUNICATION_SOURCES,
          record.id,
        )}
        consultationId={record.id}
        prefix="attorney"
        history={
          historyId === null
            ? null
            : await resolveAttorneyDocumentHistory(
                ATTORNEY_COMMUNICATION_SOURCES,
                record.id,
                historyId,
              )
        }
      />
      {BACK}
    </AttorneyWorkspace>
  );
}
