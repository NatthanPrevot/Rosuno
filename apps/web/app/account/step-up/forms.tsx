"use client";

// Step-up form (MVP-001 S2).
//
// Posts one code from the account's authenticator app. The server finds the
// account's one verified factor itself; the only other field names which of
// the principal's own workspaces to return to, and the server checks it
// against a fixed allowlist. The form shows only the fixed message for the
// state the action returns.

import { useActionState } from "react";

import type { PrincipalKind } from "../../../src/application/session-assurance.ts";
import {
  CODE_FIELD,
  DESTINATION_FIELD,
  INITIAL_CODE_STATE,
} from "../../../src/application/totp-step-up.ts";
import { codeMessage } from "../../../src/presentation/authenticator-labels.ts";
import {
  Alert,
  Button,
  Cluster,
  Stack,
  TextField,
} from "../../../src/presentation/design-system.tsx";
import { confirmStepUp } from "../actions.ts";

export function StepUpForm({ kind }: { readonly kind: PrincipalKind }) {
  const [state, formAction, pending] = useActionState(
    confirmStepUp,
    INITIAL_CODE_STATE,
  );
  const message = codeMessage(state);
  return (
    <Stack>
      {message === null ? null : (
        <Alert
          tone={message.tone}
          title={message.title}
          role={message.tone === "information" ? "status" : "alert"}
        >
          {message.body}
        </Alert>
      )}
      <form action={formAction}>
        <input type="hidden" name={DESTINATION_FIELD} value={kind} />
        <Stack>
          <TextField
            id="step-up-code"
            name={CODE_FIELD}
            label="6-digit code"
            hint="The code your authenticator app shows now for this account."
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            required
            errors={
              state.status === "invalid" ? state.fieldErrors.code : undefined
            }
          />
          <Cluster>
            <Button variant="primary" type="submit" disabled={pending}>
              Confirm code
            </Button>
          </Cluster>
        </Stack>
      </form>
    </Stack>
  );
}
