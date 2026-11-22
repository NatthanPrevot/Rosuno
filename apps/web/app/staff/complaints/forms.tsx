"use client";

// Complaint workspace forms (MVP-001 S11).
//
// Each form names only the case and the step (assign, unassign, escalate,
// return to review) or the code the staff member enters for classification
// or resolution. The server re-checks the caller's step-up, identity and
// capability, and the database decides again. Each form shows only the fixed
// message for the state its action returns.

import { useActionState } from "react";

import {
  INITIAL_CASE_STATE,
  type CaseAction,
  type CaseActionState,
} from "../../../src/application/complaints.ts";
import {
  CASE_ACTION_LABELS,
  CASE_MESSAGES,
  messageOf,
} from "../../../src/presentation/completion-labels.ts";
import {
  Alert,
  Button,
  Cluster,
  Stack,
  TextField,
} from "../../../src/presentation/design-system.tsx";
import {
  classifyCaseAction,
  resolveCaseAction,
  updateCaseAction,
} from "./actions.ts";

function Outcome({ state }: { readonly state: CaseActionState }) {
  const message = messageOf(state, CASE_MESSAGES);
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

export function CaseActionsForm({
  caseId,
  actions,
}: {
  readonly caseId: string;
  readonly actions: readonly CaseAction[];
}) {
  const [state, action, pending] = useActionState<CaseActionState, FormData>(
    updateCaseAction,
    INITIAL_CASE_STATE,
  );
  return (
    <Stack gap="tight">
      <Outcome state={state} />
      <Cluster>
        {actions.map((entry) => (
          <form key={entry} action={action}>
            <input type="hidden" name="case" value={caseId} />
            <input type="hidden" name="action" value={entry} />
            <Button variant="secondary" type="submit" disabled={pending}>
              {CASE_ACTION_LABELS[entry]}
            </Button>
          </form>
        ))}
      </Cluster>
    </Stack>
  );
}

export function DecideCaseForm({
  caseId,
  kind,
}: {
  readonly caseId: string;
  readonly kind: "classify" | "resolve";
}) {
  const [state, action, pending] = useActionState<CaseActionState, FormData>(
    kind === "classify" ? classifyCaseAction : resolveCaseAction,
    INITIAL_CASE_STATE,
  );
  return (
    <form action={action}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="case" value={caseId} />
        <TextField
          id={`${kind}-${caseId}`}
          name="code"
          label={kind === "classify" ? "Category code" : "Resolution code"}
          hint="A code from the configured list."
          autoComplete="off"
          required
        />
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            {kind === "classify" ? "Classify" : "Resolve"}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
