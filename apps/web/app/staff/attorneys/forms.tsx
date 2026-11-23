"use client";

// Attorney lifecycle panel (MVP-001 S11 pass 2).
//
// One form per offered intent (reinstate or remove), each posting the
// profile, the intent and the required staff note. The panel keeps one
// action state and stays mounted while the page re-renders, so the fixed
// message for the state its action returned stays visible after the stage
// changes (when the offered intents change). The server re-checks the
// caller's step-up, identity and capability, and the database decides again.

import { useActionState } from "react";

import {
  INITIAL_LIFECYCLE_STATE,
  MAX_STAFF_NOTE,
  type LifecycleActionState,
  type LifecycleIntent,
} from "../../../src/application/administration-workspace.ts";
import {
  Alert,
  Button,
  Cluster,
  Heading,
  Stack,
  Text,
  TextAreaField,
} from "../../../src/presentation/design-system.tsx";
import {
  LIFECYCLE_INTENT_LABELS,
  LIFECYCLE_MESSAGES,
  messageOf,
  REMOVAL_NOTE,
} from "../../../src/presentation/operations-labels.ts";
import { changeAttorneyLifecycleAction } from "./actions.ts";

function Outcome({ state }: { readonly state: LifecycleActionState }) {
  const message = messageOf(state, LIFECYCLE_MESSAGES);
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

export function AttorneyLifecyclePanel({
  attorney,
  intents,
}: {
  readonly attorney: string;
  readonly intents: readonly LifecycleIntent[];
}) {
  const [state, action, pending] = useActionState<
    LifecycleActionState,
    FormData
  >(changeAttorneyLifecycleAction, INITIAL_LIFECYCLE_STATE);
  return (
    <Stack>
      <Outcome state={state} />
      {intents.length === 0 ? (
        <Text tone="muted">
          No lifecycle change is available at this stage.
        </Text>
      ) : null}
      {intents.map((intent) => (
        <form key={intent} action={action}>
          <Stack gap="tight">
            <Heading as="h2" size="md">
              {LIFECYCLE_INTENT_LABELS[intent]}
            </Heading>
            {intent === "remove" ? (
              <Text size="small" tone="muted">
                {REMOVAL_NOTE}
              </Text>
            ) : null}
            <input type="hidden" name="attorney" value={attorney} />
            <input type="hidden" name="intent" value={intent} />
            <TextAreaField
              id={`attorney-note-${intent}`}
              name="note"
              label="Staff note"
              hint={`Required, at most ${MAX_STAFF_NOTE} characters. Kept on the audit record only.`}
              maxLength={MAX_STAFF_NOTE}
              required
            />
            <Cluster>
              <Button
                variant={intent === "remove" ? "secondary" : "primary"}
                type="submit"
                disabled={pending}
              >
                {LIFECYCLE_INTENT_LABELS[intent]}
              </Button>
            </Cluster>
          </Stack>
        </form>
      ))}
    </Stack>
  );
}
