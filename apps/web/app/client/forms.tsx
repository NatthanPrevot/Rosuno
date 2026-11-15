"use client";

// Client workspace start form (P5-001). It posts to the start action and
// shows only the fixed message for the state that action returns; on
// success the server redirects to the new Intake.

import { useActionState } from "react";

import { INITIAL_CLIENT_INTAKE_STATE } from "../../src/application/client-intake.ts";
import { Alert, Button } from "../../src/presentation/design-system.tsx";
import { outcomeMessage } from "../../src/presentation/client-intake-labels.ts";
import { startIntakeAction } from "./actions.ts";

export function StartIntakeForm() {
  const [state, action, pending] = useActionState(
    startIntakeAction,
    INITIAL_CLIENT_INTAKE_STATE,
  );
  const message = outcomeMessage(state);
  return (
    <form action={action}>
      {message === null ? null : (
        <Alert
          tone={message.tone}
          title={message.title}
          role={message.tone === "error" ? "alert" : "status"}
        >
          {message.body}
        </Alert>
      )}
      <Button variant="primary" type="submit" disabled={pending}>
        Start a new Intake
      </Button>
    </form>
  );
}
