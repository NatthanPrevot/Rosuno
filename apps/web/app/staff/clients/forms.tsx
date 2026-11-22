"use client";

// Client account-state form (MVP-001 S11 pass 2).
//
// Posts the client, the intent (suspend or reactivate) and the required
// staff note. The server re-checks the caller's step-up, identity and
// capability, and the database decides again. The form shows only the fixed
// message for the state its action returns.

import { useActionState } from "react";

import {
  INITIAL_CLIENT_STATE,
  MAX_STAFF_NOTE,
  type ClientActionState,
  type ClientIntent,
} from "../../../src/application/administration-workspace.ts";
import {
  Alert,
  Button,
  Cluster,
  Stack,
  Text,
  TextAreaField,
} from "../../../src/presentation/design-system.tsx";
import {
  CLIENT_MESSAGES,
  CLIENT_SUSPENSION_NOTE,
  messageOf,
} from "../../../src/presentation/operations-labels.ts";
import { changeClientAccountAction } from "./actions.ts";

function Outcome({ state }: { readonly state: ClientActionState }) {
  const message = messageOf(state, CLIENT_MESSAGES);
  return message === null ? null : (
    <Alert
      tone={message.tone}
      title={message.title}
      role={message.tone === "error" ? "alert" : "status"}
    >
      {message.body}
    </Alert>
  );
}

export function ClientAccountForm({
  client,
  intent,
}: {
  readonly client: string;
  readonly intent: ClientIntent;
}) {
  const [state, action, pending] = useActionState<ClientActionState, FormData>(
    changeClientAccountAction,
    INITIAL_CLIENT_STATE,
  );
  return (
    <form action={action}>
      <Stack gap="tight">
        <Outcome state={state} />
        {intent === "suspend" ? (
          <Text size="small" tone="muted">
            {CLIENT_SUSPENSION_NOTE}
          </Text>
        ) : null}
        <input type="hidden" name="client" value={client} />
        <input type="hidden" name="intent" value={intent} />
        <TextAreaField
          id={`client-note-${intent}`}
          name="note"
          label="Staff note"
          hint={`Required, at most ${MAX_STAFF_NOTE} characters. Kept on the audit record only.`}
          maxLength={MAX_STAFF_NOTE}
          required
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            {intent === "suspend"
              ? "Suspend the account"
              : "Reactivate the account"}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
