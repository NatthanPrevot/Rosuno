"use client";

// Data request staff forms (MVP-001 S11; PS-A6 section 3).
//
// The assignment form names only the request; the decision form names the
// request and one outcome code. The server re-checks the caller's step-up,
// identity and capability, and the database decides again. Each form shows
// only the fixed message for the state its action returns.

import { useActionState } from "react";

import {
  INITIAL_STAFF_STATE,
  OUTCOME_CODES,
  type StaffActionState,
} from "../../../src/application/data-requests.ts";
import { messageOf } from "../../../src/presentation/completion-labels.ts";
import {
  Alert,
  Button,
  Cluster,
  SelectField,
  Stack,
} from "../../../src/presentation/design-system.tsx";
import {
  OUTCOME_LABELS,
  STAFF_REQUEST_MESSAGES,
} from "../../../src/presentation/privacy-labels.ts";
import { assignDataRequestAction, decideDataRequestAction } from "./actions.ts";

function Outcome({ state }: { readonly state: StaffActionState }) {
  const message = messageOf(state, STAFF_REQUEST_MESSAGES);
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

// The assignment form stays mounted in one slot (as the decision form), so
// its message stays in view once the request is assigned to the caller; it
// offers its button only while an assignment is possible.
export function AssignRequestForm({
  request,
  label,
}: {
  readonly request: string;
  // The button's label, or null when no assignment is possible now.
  readonly label: string | null;
}) {
  const [state, action, pending] = useActionState<StaffActionState, FormData>(
    assignDataRequestAction,
    INITIAL_STAFF_STATE,
  );
  if (label === null) {
    return <Outcome state={state} />;
  }
  return (
    <form action={action}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="request" value={request} />
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            {label}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

// The decision form stays mounted once the request is decided (the page keeps
// it in one slot), so the message for the state its action returned is still
// shown; a request that is not in review offers no fields.
export function DecideRequestForm({
  request,
  open,
}: {
  readonly request: string;
  readonly open: boolean;
}) {
  const [state, action, pending] = useActionState<StaffActionState, FormData>(
    decideDataRequestAction,
    INITIAL_STAFF_STATE,
  );
  if (!open) {
    return <Outcome state={state} />;
  }
  return (
    <form action={action}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="request" value={request} />
        <SelectField
          id={`decide-${request}`}
          name="outcome"
          label="Decision"
          required
          defaultValue=""
        >
          <option value="" disabled>
            Choose
          </option>
          {OUTCOME_CODES.map((code) => (
            <option key={code} value={code}>
              {OUTCOME_LABELS[code]}
            </option>
          ))}
        </SelectField>
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Record the decision
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
