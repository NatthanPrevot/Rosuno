"use client";

// The attorney's report form (MVP-001 S11).
//
// The form may name one of the attorney's own Consultations and carry an
// optional statement (PS-A6 section 5); the attorney is always the
// complainant and the server decides afresh. It shows only the fixed message
// for the state its action returns.

import { useActionState } from "react";

import {
  INITIAL_OPEN_STATE,
  MAX_STATEMENT,
  type OpenActionState,
} from "../../../src/application/complaints.ts";
import {
  COMPLAINT_STATEMENT_HINT,
  messageOf,
  OPEN_MESSAGES,
} from "../../../src/presentation/completion-labels.ts";
import {
  Alert,
  Button,
  Cluster,
  SelectField,
  Stack,
  TextAreaField,
} from "../../../src/presentation/design-system.tsx";
import { openComplaintAction } from "./actions.ts";

export function ReportForm({
  consultations,
  selected,
}: {
  // The client's own Consultations: id and a plain description.
  readonly consultations: readonly {
    readonly id: string;
    readonly label: string;
  }[];
  readonly selected: string | null;
}) {
  const [state, action, pending] = useActionState<OpenActionState, FormData>(
    openComplaintAction,
    INITIAL_OPEN_STATE,
  );
  const message = messageOf(state, OPEN_MESSAGES);
  return (
    <form action={action}>
      <Stack gap="tight">
        {message === null ? null : (
          <Alert
            tone={message.tone}
            title={message.title}
            role={message.tone === "error" ? "alert" : "status"}
          >
            {message.body}
          </Alert>
        )}
        <SelectField
          id="report-consultation"
          name="consultation"
          label="Which consultation is it about?"
          hint="Choose none if it is not about one consultation."
          defaultValue={selected ?? ""}
        >
          <option value="">None</option>
          {consultations.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </SelectField>
        <TextAreaField
          id="report-statement"
          name="statement"
          label="What happened (optional)"
          hint={`${COMPLAINT_STATEMENT_HINT} At most ${MAX_STATEMENT.toLocaleString("en-US")} characters.`}
          maxLength={MAX_STATEMENT}
        />
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Report the problem
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
