"use client";

import { useActionState } from "react";

import { INITIAL_RECOVERY_REQUEST_STATE } from "../../src/application/account-recovery.ts";
import type { FieldErrors } from "../../src/application/form-operation.ts";
import {
  Alert,
  Button,
  ButtonLink,
  Cluster,
  Eyebrow,
  Heading,
  Page,
  Stack,
  Surface,
  Text,
  TextField,
} from "../../src/presentation/design-system.tsx";
import { requestRecovery } from "./actions.ts";

// Password recovery request. Opening the page asks for nothing; only a
// deliberate submission reaches the server action, which decides the
// outcome. This page shows only the fixed message for the state it returns,
// and never says whether an account exists or that an email was delivered.
export default function ForgotPasswordPage() {
  const [state, formAction, pending] = useActionState(
    requestRecovery,
    INITIAL_RECOVERY_REQUEST_STATE,
  );
  const fieldErrors: FieldErrors =
    state.status === "invalid" ? state.fieldErrors : {};
  return (
    <Page density="public">
      <Surface emphasis="raised" labelledBy="forgot-password-title">
        <Stack>
          <Eyebrow>Rosuno</Eyebrow>
          <Heading as="h1" size="lg" id="forgot-password-title">
            Reset your password
          </Heading>
          <Text tone="muted">
            Enter the email address of your account. If it belongs to an
            account, we&apos;ll ask for a recovery link to be sent to it. Open
            that link in this browser to choose a new password.
          </Text>
          {state.status === "submitted" ? (
            <Alert tone="information" title="Check your email" role="status">
              If this email address belongs to an account, a recovery link has
              been requested for it. Delivery isn&apos;t guaranteed. Open the
              link in this browser, and request a new one if no email arrives.
            </Alert>
          ) : null}
          {state.status === "unavailable" ? (
            <Alert
              tone="error"
              title="Password recovery is unavailable"
              role="alert"
            >
              Password recovery isn&apos;t available right now. Please try again
              later.
            </Alert>
          ) : null}
          {state.status === "invalid" ? (
            <Alert tone="error" title="Check the form" role="alert">
              Some details need attention before you can request a recovery
              link.
            </Alert>
          ) : null}
          <form action={formAction}>
            <Stack>
              <TextField
                id="forgot-password-email"
                name="email"
                label="Email address"
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                required
                errors={fieldErrors.email}
              />
              <Cluster>
                <Button variant="primary" type="submit" disabled={pending}>
                  Request recovery link
                </Button>
                <ButtonLink variant="secondary" href="/sign-in">
                  Return to sign in
                </ButtonLink>
                <ButtonLink variant="tertiary" href="/">
                  Return to the home page
                </ButtonLink>
              </Cluster>
            </Stack>
          </form>
        </Stack>
      </Surface>
    </Page>
  );
}
