"use client";

import { useActionState, useState } from "react";

import { INITIAL_REGISTRATION_STATE } from "../../src/application/client-registration.ts";
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
import { register } from "./actions.ts";

// Client registration entry. The server action decides the outcome; this page
// shows only the fixed message for the state it returns. The two show and
// hide controls change only how each password is displayed: values stay in
// their own fields, so password managers, autofill, and copy and paste work
// as usual, and nothing is kept in page state.
export default function SignUpPage() {
  const [state, formAction, pending] = useActionState(
    register,
    INITIAL_REGISTRATION_STATE,
  );
  const [passwordShown, setPasswordShown] = useState(false);
  const [confirmationShown, setConfirmationShown] = useState(false);
  const fieldErrors: FieldErrors =
    state.status === "invalid" ? state.fieldErrors : {};
  return (
    <Page density="public">
      <Surface emphasis="raised" labelledBy="sign-up-title">
        <Stack>
          <Eyebrow>Rosuno</Eyebrow>
          <Heading as="h1" size="lg" id="sign-up-title">
            Create an account
          </Heading>
          <Text tone="muted">
            Enter your email address and choose a password. We will ask you to
            confirm your email address before your account can be used.
          </Text>
          {state.status === "submitted" ? (
            <Alert tone="information" title="Check your email" role="status">
              If this email address can be used for a new account, look for a
              confirmation link from Rosuno. Delivery isn&apos;t guaranteed, and
              nothing is active until you use the link. If no email arrives, you
              may already have an account: try signing in.
            </Alert>
          ) : null}
          {state.status === "unavailable" ? (
            <Alert
              tone="error"
              title="Account creation is unavailable"
              role="alert"
            >
              Account creation isn&apos;t available right now. Please try again
              later.
            </Alert>
          ) : null}
          {state.status === "invalid" ? (
            <Alert tone="error" title="Check the form" role="alert">
              Some details need attention before you can create an account.
            </Alert>
          ) : null}
          <form action={formAction}>
            <Stack>
              <TextField
                id="sign-up-email"
                name="email"
                label="Email address"
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                required
                errors={fieldErrors.email}
              />
              <TextField
                id="sign-up-password"
                name="password"
                label="Password"
                type={passwordShown ? "text" : "password"}
                autoComplete="new-password"
                autoCapitalize="none"
                spellCheck={false}
                required
                hint="Use at least 15 characters. Emojis aren't allowed."
                errors={fieldErrors.password}
              />
              <Cluster>
                <Button
                  variant="tertiary"
                  aria-controls="sign-up-password"
                  onClick={() => setPasswordShown(!passwordShown)}
                >
                  {passwordShown ? "Hide password" : "Show password"}
                </Button>
              </Cluster>
              <TextField
                id="sign-up-confirm-password"
                name="confirm_password"
                label="Confirm password"
                type={confirmationShown ? "text" : "password"}
                autoComplete="new-password"
                autoCapitalize="none"
                spellCheck={false}
                required
                errors={fieldErrors.confirm_password}
              />
              <Cluster>
                <Button
                  variant="tertiary"
                  aria-controls="sign-up-confirm-password"
                  onClick={() => setConfirmationShown(!confirmationShown)}
                >
                  {confirmationShown
                    ? "Hide confirm password"
                    : "Show confirm password"}
                </Button>
              </Cluster>
              <Cluster>
                <Button variant="primary" type="submit" disabled={pending}>
                  Create account
                </Button>
                <ButtonLink variant="secondary" href="/sign-in">
                  Sign in instead
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
