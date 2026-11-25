"use client";

// Client workspace start form (P5-001). It posts to the start action and
// shows only the fixed message for the state that action returns; on
// success the server redirects to the new Intake. DEV-001: the owner's UI/UX
// design names the action after the legal matter it starts ("Start a new
// matter", or, where the list is empty, the design's "Help me find an
// attorney"); the form and its action are unchanged.

import { useActionState } from "react";

import { INITIAL_CLIENT_INTAKE_STATE } from "../../src/application/client-intake.ts";
import { Alert } from "../../src/presentation/design-system.tsx";
import { outcomeMessage } from "../../src/presentation/client-intake-labels.ts";
import { startIntakeAction } from "./actions.ts";

export function StartIntakeForm({
  prominent = false,
}: {
  // The empty list's call to action (the design's ink button).
  readonly prominent?: boolean;
}) {
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
      <button
        className={prominent ? "btn btn-ink btn-sm" : "btn btn-line btn-sm"}
        type="submit"
        disabled={pending}
      >
        {prominent ? "Help me find an attorney" : "Start a new matter"}
      </button>
    </form>
  );
}
