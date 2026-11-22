"use client";

// Break-glass forms (MVP-001 S11; PS-A6 section 2).
//
// The request form posts the Consultation's identifier and the reason; the
// approval form names the grant and the duration in minutes (required, no
// default); the revocation form names only the grant. The server re-checks
// the caller's step-up, identity and capability, and the database decides
// again. Each form shows only the fixed message for the state its action
// returns.

import { useActionState } from "react";

import {
  INITIAL_GRANT_STATE,
  MAX_DURATION_MINUTES,
  MAX_REASON,
  type GrantActionState,
} from "../../../src/application/break-glass.ts";
import { messageOf } from "../../../src/presentation/completion-labels.ts";
import {
  Alert,
  Button,
  Cluster,
  Stack,
  TextAreaField,
  TextField,
} from "../../../src/presentation/design-system.tsx";
import { GRANT_MESSAGES } from "../../../src/presentation/privacy-labels.ts";
import {
  approveBreakGlassAction,
  requestBreakGlassAction,
  revokeBreakGlassAction,
} from "./actions.ts";

function Outcome({ state }: { readonly state: GrantActionState }) {
  const message = messageOf(state, GRANT_MESSAGES);
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

export function RequestAccessForm() {
  const [state, action, pending] = useActionState<GrantActionState, FormData>(
    requestBreakGlassAction,
    INITIAL_GRANT_STATE,
  );
  return (
    <form action={action}>
      <Stack gap="tight">
        <Outcome state={state} />
        <TextField
          id="break-glass-consultation"
          name="consultation"
          label="Consultation identifier"
          hint="The identifier shown in Rosuno for the consultation."
          autoComplete="off"
          required
        />
        <TextAreaField
          id="break-glass-reason"
          name="reason"
          label="Reason"
          hint={`Required, at most ${MAX_REASON.toLocaleString("en-US")} characters. Seen by you and the staff who decide on break-glass requests.`}
          maxLength={MAX_REASON}
          required
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Request break-glass access
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function ApproveAccessForm({ grant }: { readonly grant: string }) {
  const [state, action, pending] = useActionState<GrantActionState, FormData>(
    approveBreakGlassAction,
    INITIAL_GRANT_STATE,
  );
  return (
    <form action={action}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="grant" value={grant} />
        <TextField
          id={`break-glass-minutes-${grant}`}
          name="minutes"
          label="Duration in minutes"
          hint={`From 1 to ${MAX_DURATION_MINUTES.toLocaleString("en-US")} minutes (24 hours). The access starts when you approve it.`}
          type="number"
          min={1}
          max={MAX_DURATION_MINUTES}
          step={1}
          inputMode="numeric"
          autoComplete="off"
          required
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Approve
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function RevokeAccessForm({
  grant,
  label,
}: {
  readonly grant: string;
  readonly label: string;
}) {
  const [state, action, pending] = useActionState<GrantActionState, FormData>(
    revokeBreakGlassAction,
    INITIAL_GRANT_STATE,
  );
  return (
    <form action={action}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="grant" value={grant} />
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            {label}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
