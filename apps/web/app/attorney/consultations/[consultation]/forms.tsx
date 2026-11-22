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

import { useActionState, useState } from "react";

import {
  INITIAL_COMMUNICATION_STATE,
  type CommunicationActionState,
} from "../../../../src/application/consultation-communication.ts";
import {
  INITIAL_CANCEL_STATE,
  INITIAL_END_EARLY_STATE,
  type CancelActionState,
  type EndEarlyActionState,
} from "../../../../src/application/consultation-outcomes.ts";
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
  REPLACE_FIELD_HINT,
  REPLACE_FIELD_LABEL,
  REPLACE_LABEL,
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
  CANCEL_CONFIRM_LABEL,
  CANCEL_CONFIRM_PROMPT,
  CANCEL_KEEP_LABEL,
  CANCEL_LABEL,
  CANCEL_MESSAGES,
  CANCEL_NOTE,
  END_EARLY_MESSAGES,
  END_EARLY_NOTE,
  messageOf,
} from "../../../../src/presentation/completion-labels.ts";
import {
  Alert,
  Button,
  Cluster,
  MediaFrame,
  Stack,
  Text,
  TextAreaField,
  TextField,
} from "../../../../src/presentation/design-system.tsx";
import {
  cancelConsultationAction,
  endConsultationAction,
  endEarlyAction,
  joinConsultationAction,
  openDocumentAction,
  replaceDocumentAction,
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

// MVP-001 S11: cancelling before the start and ending early by agreement,
// offered as the page reports them possible; the server decides again on
// submission. A hidden field only names the Consultation.
export function CompletionPanel({
  consultationId,
  cancellable,
  endableEarly,
}: {
  readonly consultationId: string;
  readonly cancellable: boolean;
  readonly endableEarly: boolean;
}) {
  const [cancelState, cancelAction, cancelling] = useActionState<
    CancelActionState,
    FormData
  >(cancelConsultationAction, INITIAL_CANCEL_STATE);
  const [earlyState, earlyAction, ending] = useActionState<
    EndEarlyActionState,
    FormData
  >(endEarlyAction, INITIAL_END_EARLY_STATE);
  const pending = cancelling || ending;
  // Correction pass (A7): the cancellation is asked for in two steps; the
  // second (sending the form) lasts until the next cancellation answer.
  const [confirmingAt, setConfirmingAt] = useState<CancelActionState | null>(
    null,
  );
  return (
    <Stack gap="tight">
      <Message message={messageOf(cancelState, CANCEL_MESSAGES)} />
      <Message message={messageOf(earlyState, END_EARLY_MESSAGES)} />
      {!cancellable ? null : confirmingAt === cancelState ? (
        <form action={cancelAction}>
          <Stack gap="tight">
            <Text size="small" tone="muted">
              {CANCEL_NOTE}
            </Text>
            <Text size="small">{CANCEL_CONFIRM_PROMPT}</Text>
            <input type="hidden" name="consultation" value={consultationId} />
            <Cluster>
              <Button variant="secondary" type="submit" disabled={pending}>
                {CANCEL_CONFIRM_LABEL}
              </Button>
              <Button
                variant="tertiary"
                disabled={pending}
                onClick={() => setConfirmingAt(null)}
              >
                {CANCEL_KEEP_LABEL}
              </Button>
            </Cluster>
          </Stack>
        </form>
      ) : (
        <Stack gap="tight">
          <Text size="small" tone="muted">
            {CANCEL_NOTE}
          </Text>
          <Cluster>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => setConfirmingAt(cancelState)}
            >
              {CANCEL_LABEL}
            </Button>
          </Cluster>
        </Stack>
      )}
      {endableEarly ? (
        <form action={earlyAction}>
          <Stack gap="tight">
            <Text size="small" tone="muted">
              {END_EARLY_NOTE}
            </Text>
            <input type="hidden" name="consultation" value={consultationId} />
            <Cluster>
              <Button variant="secondary" type="submit" disabled={pending}>
                End early by agreement
              </Button>
            </Cluster>
          </Stack>
        </form>
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

// MVP-001 S10 (PS-A5): the uploader's replacement of the current version.
// The new version's type, size and digest are measured on the server; the
// database decides again that this is the current version of the caller's
// own document and that communication is still open.
export function DocumentReplace({
  consultationId,
  documentId,
}: {
  readonly consultationId: string;
  readonly documentId: string;
}) {
  const [state, action, pending] = useActionState(
    replaceDocumentAction,
    INITIAL_COMMUNICATION_STATE,
  );
  return (
    <form action={action}>
      <Stack gap="tight">
        <CommunicationOutcome state={state} />
        <input type="hidden" name="consultation" value={consultationId} />
        <input type="hidden" name="document" value={documentId} />
        <TextField
          id={`attorney-replacement-${documentId}`}
          name="replacement"
          type="file"
          accept="application/pdf,image/png,image/jpeg"
          label={REPLACE_FIELD_LABEL}
          hint={REPLACE_FIELD_HINT}
          required
        />
        <Cluster>
          <Button variant="tertiary" type="submit" disabled={pending}>
            {REPLACE_LABEL}
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
