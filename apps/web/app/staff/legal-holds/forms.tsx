"use client";

// Legal Hold forms (MVP-001 S11).
//
// The placing form posts the scope, its identifier and the reason (the scope
// may be fixed by the page, as from a reported problem's page); the release
// form names only the hold. The server re-checks the caller's step-up,
// identity and capability, and the database decides again. Each form shows
// only the fixed message for the state its action returns.

import { useActionState } from "react";

import {
  HOLD_SCOPES,
  INITIAL_HOLD_STATE,
  MAX_HOLD_REASON,
  type HoldActionState,
  type HoldScope,
} from "../../../src/application/legal-holds.ts";
import {
  HOLD_MESSAGES,
  HOLD_NOTE,
  HOLD_SCOPE_LABELS,
  messageOf,
} from "../../../src/presentation/completion-labels.ts";
import {
  Alert,
  Button,
  Cluster,
  SelectField,
  Stack,
  Text,
  TextAreaField,
  TextField,
} from "../../../src/presentation/design-system.tsx";
import { placeHoldAction, releaseHoldAction } from "./actions.ts";

function Outcome({ state }: { readonly state: HoldActionState }) {
  const message = messageOf(state, HOLD_MESSAGES);
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

export function PlaceHoldForm({
  scope,
}: {
  // A fixed scope (its type and identifier), or null for the staff member's
  // own entry.
  readonly scope: { readonly type: HoldScope; readonly id: string } | null;
}) {
  const [state, action, pending] = useActionState<HoldActionState, FormData>(
    placeHoldAction,
    INITIAL_HOLD_STATE,
  );
  return (
    <form action={action}>
      <Stack gap="tight">
        <Outcome state={state} />
        <Text size="small" tone="muted">
          {HOLD_NOTE}
        </Text>
        {scope === null ? (
          <>
            <SelectField
              id="hold-scope"
              name="scope"
              label="What the hold covers"
              required
              defaultValue=""
            >
              <option value="" disabled>
                Choose
              </option>
              {HOLD_SCOPES.map((entry) => (
                <option key={entry} value={entry}>
                  {HOLD_SCOPE_LABELS[entry]}
                </option>
              ))}
            </SelectField>
            <TextField
              id="hold-scope-id"
              name="scope_id"
              label="Its identifier"
              hint="The identifier shown in Rosuno for the record."
              autoComplete="off"
              required
            />
          </>
        ) : (
          <>
            <input type="hidden" name="scope" value={scope.type} />
            <input type="hidden" name="scope_id" value={scope.id} />
          </>
        )}
        <TextAreaField
          id={scope === null ? "hold-reason" : `hold-reason-${scope.id}`}
          name="reason"
          label="Reason"
          hint={`Required, at most ${MAX_HOLD_REASON.toLocaleString("en-US")} characters. Kept on the hold only.`}
          maxLength={MAX_HOLD_REASON}
          required
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Place the Legal Hold
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function ReleaseHoldForm({ hold }: { readonly hold: string }) {
  const [state, action, pending] = useActionState<HoldActionState, FormData>(
    releaseHoldAction,
    INITIAL_HOLD_STATE,
  );
  return (
    <form action={action}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="hold" value={hold} />
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            Release the Legal Hold
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
