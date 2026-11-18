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
  INITIAL_JOIN_STATE,
  type JoinActionState,
} from "../../../../src/application/consultations.ts";
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
} from "../../../../src/presentation/design-system.tsx";
import { joinConsultationAction } from "../actions.ts";

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
