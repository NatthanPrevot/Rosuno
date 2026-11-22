"use client";

// Complaint workspace forms (MVP-001 S11).
//
// Each form names only the case and the step (assign, unassign, escalate,
// return to review) or the code the staff member chooses for classification
// or resolution among the codes the database answers for the case (PS-A6
// section 4; none while no complaint vocabulary is configured). The server
// re-checks the caller's step-up, identity and capability, and the database
// decides again. Each form shows only the fixed message for the state its
// action returns.

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
  SelectField,
  Stack,
  Text,
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

// The resolution form stays mounted once the case is resolved (the page keeps
// it in one slot), so the message for the state its action returned is still
// shown; a resolved case offers no fields.
export function DecideCaseForm({
  caseId,
  kind,
  codes,
  resolved = false,
}: {
  readonly caseId: string;
  readonly kind: "classify" | "resolve";
  // The configured codes for this case (empty while none is configured).
  readonly codes: readonly string[];
  readonly resolved?: boolean;
}) {
  const [state, action, pending] = useActionState<CaseActionState, FormData>(
    kind === "classify" ? classifyCaseAction : resolveCaseAction,
    INITIAL_CASE_STATE,
  );
  if (resolved) {
    return (
      <Stack gap="tight">
        <Outcome state={state} />
        <Text>This case is resolved.</Text>
      </Stack>
    );
  }
  if (codes.length === 0) {
    return (
      <Stack gap="tight">
        <Outcome state={state} />
        <Text>
          {kind === "classify"
            ? "No categories are configured for this case yet."
            : "No resolutions are configured for this case yet."}
        </Text>
      </Stack>
    );
  }
  return (
    <form action={action}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="case" value={caseId} />
        <SelectField
          id={`${kind}-${caseId}`}
          name="code"
          label={kind === "classify" ? "Category" : "Resolution"}
          hint="The configured codes for this case."
          required
          defaultValue=""
        >
          <option value="" disabled>
            Choose
          </option>
          {codes.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </SelectField>
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            {kind === "classify" ? "Classify" : "Resolve"}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
