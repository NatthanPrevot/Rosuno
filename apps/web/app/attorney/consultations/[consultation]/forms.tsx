"use client";

// The attorney's consultation room and command panels (MVP-001 S9).
//
// Each form posts to its server action and the panel shows only the fixed
// message for the state that action returns, or, once the server granted
// media access, the consultation room in a frame on the configured provider
// origin (the only frame source the Content-Security-Policy admits). The
// server decides afresh on every submission: whether the Consultation is the
// attorney's own, its state, the permitted window, every precondition of the
// start and every consequence of the end. A hidden field only names which
// Consultation the request concerns. No timer in the browser decides
// anything.

import { useActionState } from "react";

import {
  INITIAL_COMMUNICATION_STATE,
  type CommunicationActionState,
} from "../../../../src/application/consultation-communication.ts";
import {
  INITIAL_COMMAND_STATE,
  INITIAL_JOIN_STATE,
  type CommandActionState,
  type JoinActionState,
} from "../../../../src/application/consultations.ts";
import {
  communicationMessage,
  DOCUMENT_FIELD_HINT,
  DOCUMENT_FIELD_LABEL,
  DOWNLOAD_LINK_LABEL,
  MESSAGE_FIELD_HINT,
  MESSAGE_FIELD_LABEL,
  OPEN_LABEL,
  REVOKE_LABEL,
  SEND_LABEL,
  UPLOAD_LABEL,
} from "../../../../src/presentation/communication-labels.ts";
import {
  commandMessage,
  END_LABEL,
  FRAME_ALLOW,
  FRAME_TITLE,
  JOIN_LABEL,
  joinMessage,
  REJOIN_LABEL,
  START_LABEL,
} from "../../../../src/presentation/consultation-labels.ts";
import {
  Alert,
  Button,
  Cluster,
  MediaFrame,
  Stack,
  TextAreaField,
  TextField,
} from "../../../../src/presentation/design-system.tsx";
import {
  endConsultationAction,
  joinConsultationAction,
  openDocumentAction,
  revokeDocumentAction,
  sendMessageAction,
  startConsultationAction,
  uploadDocumentAction,
} from "../actions.ts";

function Message({
  message,
}: {
  readonly message: {
    readonly tone: "information" | "success" | "warning" | "error" | "neutral";
    readonly title: string;
    readonly body: string;
  } | null;
}) {
  if (message === null) {
    return null;
  }
  return (
    <Alert
      tone={message.tone}
      title={message.title}
      role={message.tone === "error" ? "alert" : "status"}
    >
      {message.body}
    </Alert>
  );
}

export function RoomPanel({
  consultationId,
  joinable,
}: {
  readonly consultationId: string;
  readonly joinable: boolean;
}) {
  const [state, action, pending] = useActionState<JoinActionState, FormData>(
    joinConsultationAction,
    INITIAL_JOIN_STATE,
  );
  return (
    <Stack gap="tight">
      <Message message={joinMessage(state)} />
      {state.status === "granted" ? (
        <MediaFrame ratio="landscape">
          <iframe
            src={state.frameUrl}
            title={FRAME_TITLE}
            allow={FRAME_ALLOW}
          />
        </MediaFrame>
      ) : null}
      {joinable ? (
        <Cluster>
          <form action={action}>
            <input type="hidden" name="consultation" value={consultationId} />
            <Button variant="secondary" type="submit" disabled={pending}>
              {state.status === "granted" ? REJOIN_LABEL : JOIN_LABEL}
            </Button>
          </form>
        </Cluster>
      ) : null}
    </Stack>
  );
}

// The start and end forms, offered as the server reports them possible. The
// panel stays mounted when the page refreshes after a command, so the fixed
// outcome message stays in view.
export function CommandPanel({
  consultationId,
  startable,
  endable,
}: {
  readonly consultationId: string;
  readonly startable: boolean;
  readonly endable: boolean;
}) {
  const [startState, startAction, starting] = useActionState<
    CommandActionState,
    FormData
  >(startConsultationAction, INITIAL_COMMAND_STATE);
  const [endState, endAction, ending] = useActionState<
    CommandActionState,
    FormData
  >(endConsultationAction, INITIAL_COMMAND_STATE);
  const pending = starting || ending;
  return (
    <Stack gap="tight">
      <Message message={commandMessage(startState)} />
      <Message message={commandMessage(endState)} />
      {startable || endable ? (
        <Cluster>
          {startable ? (
            <form action={startAction}>
              <input type="hidden" name="consultation" value={consultationId} />
              <Button variant="primary" type="submit" disabled={pending}>
                {START_LABEL}
              </Button>
            </form>
          ) : null}
          {endable ? (
            <form action={endAction}>
              <input type="hidden" name="consultation" value={consultationId} />
              <Button variant="primary" type="submit" disabled={pending}>
                {END_LABEL}
              </Button>
            </form>
          ) : null}
        </Cluster>
      ) : null}
    </Stack>
  );
}

// MVP-001 S10: the attorney's Message composer and document forms. Each form
// posts to its server action and shows only the fixed message for the state
// that action returns, or, for a document the server authorized, a download
// link valid for the signed URL's short lifetime. A hidden field only names
// which Consultation or document the request concerns; the server decides
// afresh on every submission (the Consultation's own participant, whether
// communication is still open, the grant, every refusal). The browser never
// chooses a recipient and no file name is kept.

function CommunicationOutcome({
  state,
}: {
  readonly state: CommunicationActionState;
}) {
  const message = communicationMessage(state);
  if (message === null) {
    return null;
  }
  return (
    <Alert
      tone={message.tone}
      title={message.title}
      role={message.tone === "error" ? "alert" : "status"}
    >
      {message.body}
    </Alert>
  );
}

export function MessageComposer({
  consultationId,
}: {
  readonly consultationId: string;
}) {
  const [state, action, pending] = useActionState(
    sendMessageAction,
    INITIAL_COMMUNICATION_STATE,
  );
  return (
    <form action={action}>
      <Stack gap="tight">
        <CommunicationOutcome state={state} />
        <input type="hidden" name="consultation" value={consultationId} />
        <TextAreaField
          id="attorney-message-body"
          name="body"
          label={MESSAGE_FIELD_LABEL}
          hint={MESSAGE_FIELD_HINT}
          maxLength={20000}
          rows={4}
          required
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            {SEND_LABEL}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function DocumentUpload({
  consultationId,
}: {
  readonly consultationId: string;
}) {
  const [state, action, pending] = useActionState(
    uploadDocumentAction,
    INITIAL_COMMUNICATION_STATE,
  );
  return (
    <form action={action}>
      <Stack gap="tight">
        <CommunicationOutcome state={state} />
        <input type="hidden" name="consultation" value={consultationId} />
        <TextField
          id="attorney-document-file"
          name="document"
          type="file"
          accept="application/pdf,image/png,image/jpeg"
          label={DOCUMENT_FIELD_LABEL}
          hint={DOCUMENT_FIELD_HINT}
          required
        />
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            {UPLOAD_LABEL}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function DocumentControls({
  consultationId,
  resourceId,
  openable,
  revocable,
}: {
  readonly consultationId: string;
  readonly resourceId: string;
  readonly openable: boolean;
  readonly revocable: boolean;
}) {
  const [opened, openAction, opening] = useActionState(
    openDocumentAction,
    INITIAL_COMMUNICATION_STATE,
  );
  const [revoked, revokeAction, revoking] = useActionState(
    revokeDocumentAction,
    INITIAL_COMMUNICATION_STATE,
  );
  return (
    <Stack gap="tight">
      <CommunicationOutcome state={opened} />
      <CommunicationOutcome state={revoked} />
      {opened.status === "download" ? (
        <Cluster>
          <a className="rs-button" data-variant="tertiary" href={opened.url}>
            {DOWNLOAD_LINK_LABEL}
          </a>
        </Cluster>
      ) : null}
      <Cluster>
        {openable ? (
          <form action={openAction}>
            <input type="hidden" name="resource" value={resourceId} />
            <Button variant="secondary" type="submit" disabled={opening}>
              {OPEN_LABEL}
            </Button>
          </form>
        ) : null}
        {revocable ? (
          <form action={revokeAction}>
            <input type="hidden" name="consultation" value={consultationId} />
            <input type="hidden" name="resource" value={resourceId} />
            <Button variant="tertiary" type="submit" disabled={revoking}>
              {REVOKE_LABEL}
            </Button>
          </form>
        ) : null}
      </Cluster>
    </Stack>
  );
}
