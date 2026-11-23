"use client";

// Break-glass forms (MVP-001 S11; PS-A6 section 2).
//
// The request form posts the Consultation's identifier and the reason; the
// approval form names the grant and the duration in minutes (required, no
// default); the revocation form names only the grant. The server re-checks
// the caller's step-up, identity and capability, and the database decides
// again. Each form shows only the fixed message for the state its action
// returns: the request form above its fields, the approval and revocation
// forms of the list in one slot above it (GrantDecisions), which stays
// mounted while the page is refreshed and the decided grant leaves the list.

import {
  createContext,
  useActionState,
  useContext,
  useState,
  type ReactNode,
} from "react";

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

type Decision = "approve" | "revoke";

type Decisions = {
  readonly approve: (formData: FormData) => void;
  readonly revoke: (formData: FormData) => void;
  readonly pending: boolean;
  readonly submitted: (decision: Decision) => void;
};

const DecisionsContext = createContext<Decisions | null>(null);

function useDecisions(): Decisions {
  const decisions = useContext(DecisionsContext);
  if (decisions === null) {
    throw new Error("a decision form is rendered inside GrantDecisions");
  }
  return decisions;
}

// The approval and revocation forms of the list share one message slot above
// it. A decision moves the grant out of the list it was decided from (the
// action refreshes the page), so the slot stays mounted outside the list and
// shows the fixed message for the last decision submitted here.
export function GrantDecisions({ children }: { readonly children: ReactNode }) {
  const [approved, approve, approving] = useActionState<
    GrantActionState,
    FormData
  >(approveBreakGlassAction, INITIAL_GRANT_STATE);
  const [revoked, revoke, revoking] = useActionState<
    GrantActionState,
    FormData
  >(revokeBreakGlassAction, INITIAL_GRANT_STATE);
  const [last, setLast] = useState<Decision | null>(null);
  return (
    <DecisionsContext.Provider
      value={{
        approve,
        revoke,
        pending: approving || revoking,
        submitted: setLast,
      }}
    >
      <Stack>
        {last === null ? (
          // Before hydration (or without scripts) no submission is noted
          // here; at most one action has an outcome then, and an idle state
          // shows nothing.
          <>
            <Outcome state={approved} />
            <Outcome state={revoked} />
          </>
        ) : (
          <Outcome state={last === "approve" ? approved : revoked} />
        )}
        {children}
      </Stack>
    </DecisionsContext.Provider>
  );
}

export function ApproveAccessForm({ grant }: { readonly grant: string }) {
  const { approve, pending, submitted } = useDecisions();
  return (
    <form action={approve} onSubmit={() => submitted("approve")}>
      <Stack gap="tight">
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
  const { revoke, pending, submitted } = useDecisions();
  return (
    <form action={revoke} onSubmit={() => submitted("revoke")}>
      <Stack gap="tight">
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
