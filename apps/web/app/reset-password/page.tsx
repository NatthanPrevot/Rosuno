"use client";

import { use, useActionState } from "react";

import {
  INITIAL_RECOVERY_COMPLETION_STATE,
  recoveryCodeOf,
  type RecoverySearchParams,
} from "../../src/application/account-recovery.ts";
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
import { completeRecovery } from "./actions.ts";

type ResetPasswordPageProps = {
  readonly searchParams: Promise<RecoverySearchParams>;
};

// Recovery link destination. Opening it only renders: it reads the one-time
// code from its own address into the form's hidden field, and it exchanges
// nothing, starts no session, asks no provider, and goes nowhere it is told
// to. Only a deliberate submission sends the code, with the new password, to
// the server action, which decides the outcome; this page shows only the
// fixed message for the state it returns. The form is offered only while the
// code is unused. The page asks not to be indexed or archived and sends no
// referrer, since its address carries the code, and it loads nothing from
// elsewhere.
export default function ResetPasswordPage({
  searchParams,
}: ResetPasswordPageProps) {
  const code = recoveryCodeOf(use(searchParams));
  const [state, formAction, pending] = useActionState(
    completeRecovery,
    INITIAL_RECOVERY_COMPLETION_STATE,
  );
  const fieldErrors: FieldErrors =
    state.status === "invalid" ? state.fieldErrors : {};
  const formCode =
    state.status === "idle" || state.status === "invalid" ? code : null;
  return (
    <>
      <meta name="robots" content="noindex, nofollow, noarchive" />
      <meta name="referrer" content="no-referrer" />
      <Page density="public">
        <Surface emphasis="raised" labelledBy="reset-password-title">
          <Stack>
            <Eyebrow>Rosuno</Eyebrow>
            <Heading as="h1" size="lg" id="reset-password-title">
              Choose a new password
            </Heading>
            {code === null ? (
              <Alert tone="error" title="This link can't be used" role="alert">
                The recovery link is incomplete or malformed. Open the most
                recent link from your recovery email, or request a new one.
              </Alert>
            ) : null}
            {formCode !== null ? (
              <Text tone="muted">
                Enter a new password for your account, then select Change
                password. Nothing changes until you do.
              </Text>
            ) : null}
            {state.status === "invalid" ? (
              <Alert tone="error" title="Check the form" role="alert">
                Some details need attention before you can change your password.
              </Alert>
            ) : null}
            {state.status === "unusable" ? (
              <Alert tone="error" title="This link can't be used" role="alert">
                Your password hasn&apos;t been changed. The link may have
                expired or already been used, it may have been opened in a
                different browser from the one where you asked for it, or
                recovery may be unavailable right now. Request a new link and
                open it in the same browser.
              </Alert>
            ) : null}
            {state.status === "unavailable" ? (
              <Alert
                tone="error"
                title="Password recovery is unavailable"
                role="alert"
              >
                Your password hasn&apos;t been changed. Password recovery
                isn&apos;t available right now. Please try again later.
              </Alert>
            ) : null}
            {state.status === "not-changed" ? (
              <Alert
                tone="error"
                title="Your password wasn't changed"
                role="alert"
              >
                The new password wasn&apos;t accepted. Request a new link and
                choose a different password.
              </Alert>
            ) : null}
            {state.status === "session-uncertain" ? (
              <Alert
                tone="warning"
                title="Your password wasn't changed"
                role="alert"
              >
                This browser may still be signed in. Return to the home page to
                check, and sign out there if it shows you as signed in. Then
                request a new link.
              </Alert>
            ) : null}
            {state.status === "uncertain" ? (
              <Alert
                tone="warning"
                title="The result couldn't be confirmed"
                role="alert"
              >
                Your password may or may not have been changed, and this browser
                may still be signed in. Return to the home page to check, and
                sign out there if it shows you as signed in. Then try signing in
                with your new password, and request a new link if it isn&apos;t
                accepted.
              </Alert>
            ) : null}
            {state.status === "completed" ? (
              <Alert
                tone="success"
                title="Your password has been changed"
                role="status"
              >
                This browser isn&apos;t signed in. Use your new password the
                next time you sign in.
              </Alert>
            ) : null}
            {formCode === null ? (
              <Cluster>
                {state.status === "completed" ? (
                  <ButtonLink variant="primary" href="/sign-in">
                    Sign in
                  </ButtonLink>
                ) : (
                  <ButtonLink variant="primary" href="/forgot-password">
                    Request a new link
                  </ButtonLink>
                )}
                <ButtonLink variant="tertiary" href="/">
                  Return to the home page
                </ButtonLink>
              </Cluster>
            ) : (
              <form action={formAction}>
                <input type="hidden" name="code" value={formCode} />
                <Stack>
                  <TextField
                    id="reset-password-new"
                    name="password"
                    label="New password"
                    type="password"
                    autoComplete="new-password"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    errors={fieldErrors.password}
                  />
                  <TextField
                    id="reset-password-confirm"
                    name="confirm_password"
                    label="Confirm new password"
                    type="password"
                    autoComplete="new-password"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    errors={fieldErrors.confirm_password}
                  />
                  <Cluster>
                    <Button variant="primary" type="submit" disabled={pending}>
                      Change password
                    </Button>
                    <ButtonLink variant="tertiary" href="/">
                      Return to the home page
                    </ButtonLink>
                  </Cluster>
                </Stack>
              </form>
            )}
          </Stack>
        </Surface>
      </Page>
    </>
  );
}
