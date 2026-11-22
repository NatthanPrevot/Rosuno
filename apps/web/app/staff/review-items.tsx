"use client";

// Review item controls of the operations and compliance families (MVP-001
// S11).
//
// The page hands in the two server actions of its own family. Each form names
// only the review item it concerns and posts the staff member's own entries
// (the resolution notes). The server re-checks the caller's step-up, identity
// and the family's capability before anything is sent, and the database
// decides again by the item's own family and audits every change. Each form
// shows only the fixed message for the state its action returns.

import { useActionState } from "react";

import {
  INITIAL_REVIEW_ITEM_STATE,
  type ReviewItemActionState,
} from "../../src/application/consultation-outcomes.ts";
import {
  messageOf,
  REVIEW_ITEM_MESSAGES,
} from "../../src/presentation/completion-labels.ts";
import {
  Alert,
  Button,
  Cluster,
  Stack,
  TextAreaField,
} from "../../src/presentation/design-system.tsx";

type ItemAction = (
  previous: ReviewItemActionState,
  formData: FormData,
) => Promise<ReviewItemActionState>;

function Outcome({ state }: { readonly state: ReviewItemActionState }) {
  const message = messageOf(state, REVIEW_ITEM_MESSAGES);
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

export function ReviewItemControls({
  exception,
  assignedToMe,
  assignAction,
  resolveAction,
}: {
  readonly exception: string;
  readonly assignedToMe: boolean;
  readonly assignAction: ItemAction;
  readonly resolveAction: ItemAction;
}) {
  const [assignState, assign, assigning] = useActionState(
    assignAction,
    INITIAL_REVIEW_ITEM_STATE,
  );
  const [resolveState, resolve, resolving] = useActionState(
    resolveAction,
    INITIAL_REVIEW_ITEM_STATE,
  );
  const pending = assigning || resolving;
  return (
    <Stack gap="tight">
      <Outcome state={assignState} />
      <form action={assign}>
        <input type="hidden" name="exception" value={exception} />
        <input
          type="hidden"
          name="assign"
          value={assignedToMe ? "nobody" : "me"}
        />
        <Cluster>
          <Button variant="tertiary" type="submit" disabled={pending}>
            {assignedToMe ? "Clear assignment" : "Assign to me"}
          </Button>
        </Cluster>
      </form>
      <Outcome state={resolveState} />
      <form action={resolve}>
        <Stack gap="tight">
          <input type="hidden" name="exception" value={exception} />
          <TextAreaField
            id={`resolve-${exception}`}
            name="notes"
            label="Resolution notes"
            hint="Required, at most 2,000 characters."
            maxLength={2000}
            required
          />
          <Cluster>
            <Button variant="secondary" type="submit" disabled={pending}>
              Resolve
            </Button>
          </Cluster>
        </Stack>
      </form>
    </Stack>
  );
}
