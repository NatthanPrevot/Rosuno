"use client";

import { use, useActionState } from "react";

import { INITIAL_SIGN_IN_STATE } from "../../src/application/authentication-entry.ts";
import type { FieldErrors } from "../../src/application/form-operation.ts";
import {
  CONTINUATION_FIELD,
  continuationOf,
} from "../../src/application/sign-in-continuation.ts";
import {
  Alert,
  Button,
  ButtonLink,
  Cluster,
  Eyebrow,
  Heading,
  Stack,
  Surface,
  Text,
  TextField,
} from "../../src/presentation/design-system.tsx";
import { AuthFrame } from "../../src/presentation/auth-frame.tsx";
import { keepEntries } from "../../src/presentation/form-entries.ts";
import { signIn } from "./actions.ts";

// Sign-in entry for an existing account. The server action decides the
// outcome; this page shows only the fixed message for the state it returns.
// After each submission the email address stays as typed and the password
// is cleared.
// MVP-001 S5: the one query value read, continuation, may name the attorney
// selection page with its own checked parameters; only that rebuilt path is
// posted back with the form, and the server checks it again before it
// continues there after sign-in (anything else returns to the home page).
export default function SignInPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly continuation?: string | string[];
  }>;
}) {
  const continuation = continuationOf(use(searchParams).continuation);
  const [state, formAction, pending] = useActionState(
    signIn,
    INITIAL_SIGN_IN_STATE,
  );
  const fieldErrors: FieldErrors =
    state.status === "invalid" ? state.fieldErrors : {};
  return (
    <AuthFrame>
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
          {state.status === "throttled" ? (
            <Alert tone="error" title="Too many attempts" role="alert">
              Too many sign-in attempts have been made. Please wait a while and
              try again later.
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
          <form action={formAction} onReset={keepEntries(["email"])}>
            {continuation === null ? null : (
              <input
                type="hidden"
                name={CONTINUATION_FIELD}
                value={continuation}
              />
            )}
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
                <ButtonLink variant="tertiary" href="/forgot-password">
                  Forgot password?
                </ButtonLink>
                <ButtonLink variant="tertiary" href="/">
                  Return to the home page
                </ButtonLink>
              </Cluster>
            </Stack>
          </form>
        </Stack>
      </Surface>
    </AuthFrame>
  );
}
