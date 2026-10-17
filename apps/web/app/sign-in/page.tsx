"use client";

import { useActionState } from "react";

import { INITIAL_SIGN_IN_STATE } from "../../src/application/authentication-entry.ts";
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
import { signIn } from "./actions.ts";

// Sign-in entry for an existing account. The server action decides the
// outcome; this page shows only the fixed message for the state it returns.
export default function SignInPage() {
  const [state, formAction, pending] = useActionState(
    signIn,
    INITIAL_SIGN_IN_STATE,
  );
  const fieldErrors: FieldErrors =
    state.status === "invalid" ? state.fieldErrors : {};
  return (
    <Page density="public">
      <Surface emphasis="raised" labelledBy="sign-in-title">
        <Stack>
          <Eyebrow>Rosuno</Eyebrow>
          <Heading as="h1" size="lg" id="sign-in-title">
            Sign in
          </Heading>
          <Text tone="muted">
            Use the email address and password of your existing account.
          </Text>
          {state.status === "rejected" ? (
            <Alert tone="error" title="Sign-in failed" role="alert">
              The email address or password was not accepted. Check them and try
              again.
            </Alert>
          ) : null}
          {state.status === "unavailable" ? (
            <Alert tone="error" title="Sign-in is unavailable" role="alert">
              Sign-in could not be completed right now. Please try again later.
            </Alert>
          ) : null}
          {state.status === "uncertain" ? (
            <Alert
              tone="warning"
              title="Sign-in could not be confirmed"
              role="alert"
            >
              Sign-in did not complete, and this browser may still be signed in.
              Return to the home page to check, and sign out there if it shows
              you as signed in.
            </Alert>
          ) : null}
          {state.status === "invalid" ? (
            <Alert tone="error" title="Check the form" role="alert">
              Some details need attention before you can sign in.
            </Alert>
          ) : null}
          <form action={formAction}>
            <Stack>
              <TextField
                id="sign-in-email"
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
                id="sign-in-password"
                name="password"
                label="Password"
                type="password"
                autoComplete="current-password"
                required
                errors={fieldErrors.password}
              />
              <Cluster>
                <Button variant="primary" type="submit" disabled={pending}>
                  Sign in
                </Button>
                <ButtonLink variant="secondary" href="/sign-up">
                  Create an account
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
