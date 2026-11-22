"use client";

// The client's consultation room panel (MVP-001 S9).
//
// The join form posts to its server action and the panel shows only the fixed
// message for the state that action returns, or, once the server granted
// media access, the consultation room in a frame on the configured provider
// origin (the only frame source the Content-Security-Policy admits). The
// server decides afresh on every submission: whether the Consultation is the
// client's own, its state, the permitted window and the room. A hidden field
// only names which Consultation the request concerns. Joining again (after a
// dropped connection) asks the server for a new short-lived token for the
// same room. No timer in the browser decides anything.

import { useActionState } from "react";

import {
  INITIAL_COMMUNICATION_STATE,
  type CommunicationActionState,
} from "../../../../src/application/consultation-communication.ts";
import {
  INITIAL_CANCEL_STATE,
  type CancelActionState,
} from "../../../../src/application/consultation-outcomes.ts";
import {
  INITIAL_JOIN_STATE,
  type JoinActionState,
} from "../../../../src/application/consultations.ts";
import {
  CANCEL_MESSAGES,
  CANCEL_NOTE,
  messageOf,
} from "../../../../src/presentation/completion-labels.ts";
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
  FRAME_ALLOW,
  FRAME_TITLE,
  JOIN_LABEL,
  joinMessage,
  REJOIN_LABEL,
} from "../../../../src/presentation/consultation-labels.ts";
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
  joinConsultationAction,
  openDocumentAction,
  replaceDocumentAction,
  revokeDocumentAction,
  sendMessageAction,
  uploadDocumentAction,
} from "../actions.ts";

function Outcome({ state }: { readonly state: JoinActionState }) {
  const message = joinMessage(state);
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

export function JoinPanel({
  consultationId,
  joinable,
}: {
  readonly consultationId: string;
  readonly joinable: boolean;
}) {
  const [state, action, pending] = useActionState(
    joinConsultationAction,
    INITIAL_JOIN_STATE,
  );
  return (
    <Stack gap="tight">
      <Outcome state={state} />
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
            <Button variant="primary" type="submit" disabled={pending}>
              {state.status === "granted" ? REJOIN_LABEL : JOIN_LABEL}
            </Button>
          </form>
        </Cluster>
      ) : null}
    </Stack>
  );
}

// MVP-001 S10: the client's Message composer and document forms. Each form
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
          id="client-message-body"
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
          id="client-document-file"
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
          id={`client-replacement-${documentId}`}
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

// MVP-001 S11: the client cancels before the consultation starts. A hidden
// field only names the Consultation; the server decides afresh whether it is
// the client's own and whether it can still be cancelled, frees the booked
// time, closes the room and tells the attorney. No money moves here.
export function CancelPanel({
  consultationId,
  cancellable,
}: {
  readonly consultationId: string;
  // Whether the page reports the Consultation cancellable; the panel stays
  // mounted after a cancellation refreshes the page, so the fixed outcome
  // message stays in view.
  readonly cancellable: boolean;
}) {
  const [state, action, pending] = useActionState<CancelActionState, FormData>(
    cancelConsultationAction,
    INITIAL_CANCEL_STATE,
  );
  const message = messageOf(state, CANCEL_MESSAGES);
  return (
    <Stack gap="tight">
      {message === null ? null : (
        <Alert
          tone={message.tone}
          title={message.title}
          role={message.tone === "error" ? "alert" : "status"}
        >
          {message.body}
        </Alert>
      )}
      {cancellable ? (
        <form action={action}>
          <Stack gap="tight">
            <Text size="small" tone="muted">
              {CANCEL_NOTE}
            </Text>
            <input type="hidden" name="consultation" value={consultationId} />
            <Cluster>
              <Button variant="secondary" type="submit" disabled={pending}>
                Cancel the consultation
              </Button>
            </Cluster>
          </Stack>
        </form>
      ) : null}
    </Stack>
  );
}
