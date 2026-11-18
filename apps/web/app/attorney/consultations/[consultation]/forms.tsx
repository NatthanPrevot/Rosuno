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
  INITIAL_COMMAND_STATE,
  INITIAL_JOIN_STATE,
  type CommandActionState,
  type JoinActionState,
} from "../../../../src/application/consultations.ts";
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
} from "../../../../src/presentation/design-system.tsx";
import {
  endConsultationAction,
  joinConsultationAction,
  startConsultationAction,
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
