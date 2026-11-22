"use client";

// The client's report form (MVP-001 S11).
//
// The form may name one of the client's own Consultations; the client is
// always the complainant and the server decides afresh. It shows only the
// fixed message for the state its action returns.

import { useActionState } from "react";

import {
  INITIAL_OPEN_STATE,
  type OpenActionState,
} from "../../../src/application/complaints.ts";
import {
  messageOf,
  OPEN_MESSAGES,
} from "../../../src/presentation/completion-labels.ts";
import {
  Alert,
  Button,
  Cluster,
  SelectField,
  Stack,
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
        <Cluster>
          <Button variant="primary" type="submit" disabled={pending}>
            Report the problem
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
