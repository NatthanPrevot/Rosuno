"use client";

// The staff outcome command (MVP-001 S11).
//
// The form names the Consultation (a hidden field), one of the outcome codes
// the page offers for its state, and optionally the explicit acknowledgement
// that the outcome contradicts the attendance evidence. The server re-checks
// the caller's step-up, identity and capability, and the database decides
// again: the capability for the Consultation's jurisdiction, the window rule,
// the evidence and every consequence. Nothing is decided automatically. The
// form shows only the fixed message for the state its action returns.

import { useActionState } from "react";

import {
  INITIAL_RECORD_STATE,
  type RecordActionState,
  type StaffOutcomeCode,
} from "../../../src/application/consultation-outcomes.ts";
import {
  messageOf,
  RECORD_MESSAGES,
  STAFF_OUTCOME_LABELS,
} from "../../../src/presentation/completion-labels.ts";
import {
  Alert,
  Button,
  Choice,
  Cluster,
  FieldGroup,
  Stack,
} from "../../../src/presentation/design-system.tsx";
import { recordOutcomeAction } from "./actions.ts";

export function RecordOutcomeForm({
  consultation,
  codes,
}: {
  readonly consultation: string;
  readonly codes: readonly StaffOutcomeCode[];
}) {
  const [state, action, pending] = useActionState<RecordActionState, FormData>(
    recordOutcomeAction,
    INITIAL_RECORD_STATE,
  );
  const message = messageOf(state, RECORD_MESSAGES);
  // The panel stays mounted after the outcome is recorded (no codes are then
  // offered), so the fixed outcome message stays in view.
  return (
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
      {codes.length === 0 ? null : (
        <form action={action}>
          <Stack gap="tight">
            <input type="hidden" name="consultation" value={consultation} />
            <FieldGroup id="outcome-codes" legend="Outcome">
              {codes.map((code) => (
                <Choice
                  key={code}
                  type="radio"
                  name="outcome"
                  value={code}
                  label={STAFF_OUTCOME_LABELS[code]}
                  required
                />
              ))}
            </FieldGroup>
            <Choice
              type="checkbox"
              name="acknowledge"
              value="yes"
              label="I have checked the attendance evidence and record this outcome even where the evidence disagrees"
            />
            <Cluster>
              <Button variant="primary" type="submit" disabled={pending}>
                Record the outcome
              </Button>
            </Cluster>
          </Stack>
        </form>
      )}
    </Stack>
  );
}
