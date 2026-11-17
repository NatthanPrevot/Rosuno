"use client";

// Authenticator setup forms (MVP-001 S2).
//
// The first form asks the server to start a setup; the server creates the
// factor and returns its setup key and setup link, which are shown as text
// for manual entry in an authenticator app (no picture is drawn). The
// second form posts the first code from that app; the server finds the one
// pending setup itself, and the only other field names which of the
// principal's own workspaces to return to. Each shows only the fixed
// message for the state its action returns. Starting again is a fresh load
// of this page, so a setup key never travels back to the server.

import { useActionState } from "react";

import {
  ACCOUNT_PAGES,
  type PrincipalKind,
} from "../../../src/application/session-assurance.ts";
import {
  CODE_FIELD,
  DESTINATION_FIELD,
  ENROLLMENT_INTENT,
  INITIAL_CODE_STATE,
  INITIAL_ENROLLMENT_STATE,
} from "../../../src/application/totp-step-up.ts";
import {
  codeMessage,
  enrollmentMessage,
  type StepUpMessage,
} from "../../../src/presentation/authenticator-labels.ts";
import {
  Alert,
  Button,
  ButtonLink,
  Cluster,
  Stack,
  Text,
  TextField,
} from "../../../src/presentation/design-system.tsx";
import { confirmEnrollment, startEnrollment } from "../actions.ts";

function Message({ message }: { readonly message: StepUpMessage | null }) {
  if (message === null) {
    return null;
  }
  return (
    <Alert
      tone={message.tone}
      title={message.title}
      role={message.tone === "information" ? "status" : "alert"}
    >
      {message.body}
    </Alert>
  );
}

export function EnrollmentForms({ kind }: { readonly kind: PrincipalKind }) {
  const [setup, startAction, starting] = useActionState(
    startEnrollment,
    INITIAL_ENROLLMENT_STATE,
  );
  const [code, confirmAction, confirming] = useActionState(
    confirmEnrollment,
    INITIAL_CODE_STATE,
  );
  if (setup.status !== "pending") {
    return (
      <Stack>
        <Message message={enrollmentMessage(setup)} />
        <form action={startAction}>
          <input
            type="hidden"
            name={ENROLLMENT_INTENT.field}
            value={ENROLLMENT_INTENT.value}
          />
          <Cluster>
            <Button variant="primary" type="submit" disabled={starting}>
              Set up an authenticator app
            </Button>
          </Cluster>
        </form>
      </Stack>
    );
  }
  return (
    <Stack>
      <Text>
        In your authenticator app, add an account and enter this setup key by
        hand, choosing a time-based code. If your app accepts a setup link, you
        can paste the link instead.
      </Text>
      <TextField
        id="authenticator-setup-key"
        label="Setup key"
        value={setup.secret}
        readOnly
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
      />
      <TextField
        id="authenticator-setup-link"
        label="Setup link"
        value={setup.uri}
        readOnly
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
      />
      <Text tone="muted">
        Keep the setup key private: anyone who has it can produce your codes. It
        is shown only on this screen.
      </Text>
      <Message message={codeMessage(code)} />
      <form action={confirmAction}>
        <input type="hidden" name={DESTINATION_FIELD} value={kind} />
        <Stack>
          <TextField
            id="authenticator-setup-code"
            name={CODE_FIELD}
            label="6-digit code"
            hint="The code your authenticator app shows now for this account."
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            required
            errors={
              code.status === "invalid" ? code.fieldErrors.code : undefined
            }
          />
          <Cluster>
            <Button variant="primary" type="submit" disabled={confirming}>
              Confirm code
            </Button>
            <ButtonLink variant="tertiary" href={ACCOUNT_PAGES[kind].security}>
              Start again
            </ButtonLink>
          </Cluster>
        </Stack>
      </form>
    </Stack>
  );
}
