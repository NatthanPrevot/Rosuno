// Session step-up for attorney and staff accounts (MVP-001 S2).
//
// Rendered on the server for every request. The trusted session, a fresh
// read of the request's own Auth account, its active User and its own
// Staff and Attorney Profiles decide whether this is an attorney or staff
// principal, and a fresh read of the session's assurance decides which
// fixed state is shown: confirm a code from the authenticator app, set one
// up first, or continue because this session is already confirmed. The one
// query value read, to, only says which of the principal's own workspaces to
// return to; the server checks it against the principal's own kinds and
// returns only to a fixed address. The page reads no route parameter,
// header, or cookie of its own.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  ACCOUNT_PAGES,
  STEP_UP_DESTINATIONS,
} from "../../../src/application/session-assurance.ts";
import { resolveStepUp } from "../../../src/application/totp-step-up.ts";
import { AUTHENTICATOR_SOURCES } from "../../../src/infrastructure/identity/authenticator-provider.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Eyebrow,
  Heading,
  Page,
  Stack,
  Surface,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { StepUpForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Confirm your sign-in",
  robots: { index: false, follow: false },
};

function StepUpFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="public">
      <Surface emphasis="raised" labelledBy="step-up-title">
        <Stack>
          <Eyebrow>Sign-in security</Eyebrow>
          <Heading as="h1" size="lg" id="step-up-title">
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

export default async function StepUpPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly to?: string | string[] }>;
}) {
  // Assurance belongs to each request on the server; never prerender or
  // cache it.
  await connection();
  const { to } = await searchParams;
  const view = await resolveStepUp(AUTHENTICATOR_SOURCES, to);
  if (view.status === "ready") {
    return (
      <StepUpFrame title="Confirm your sign-in">
        <Text tone="muted">
          Attorney and staff work needs a confirmed sign-in. Enter the 6-digit
          code your authenticator app shows now for this account.
        </Text>
        <StepUpForm kind={view.kind} />
      </StepUpFrame>
    );
  }
  if (view.status === "set-up-required") {
    return (
      <StepUpFrame title="Set up an authenticator app first">
        <Text tone="muted">
          No authenticator app is set up for this account yet. Set one up to
          continue.
        </Text>
        <Cluster>
          <ButtonLink
            variant="primary"
            href={ACCOUNT_PAGES[view.kind].security}
          >
            Set up an authenticator app
          </ButtonLink>
        </Cluster>
      </StepUpFrame>
    );
  }
  if (view.status === "stepped-up") {
    return (
      <StepUpFrame title="Sign-in confirmed">
        <Alert tone="success" title="Already confirmed" role="status">
          This session is already confirmed with a code from your authenticator
          app.
        </Alert>
        <Cluster>
          <ButtonLink variant="primary" href={STEP_UP_DESTINATIONS[view.kind]}>
            Continue
          </ButtonLink>
        </Cluster>
      </StepUpFrame>
    );
  }
  if (view.status === "sign-in-required") {
    return (
      <StepUpFrame title="Sign in to continue">
        <Text tone="muted">
          Confirming a sign-in is available only to a signed-in attorney or
          staff account.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </StepUpFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <StepUpFrame title="Not available">
        <Alert tone="warning" title="Not available" role="status">
          This is available only to attorney and staff accounts. Any other
          access the account has is unchanged.
        </Alert>
        <Cluster>
          <ButtonLink variant="tertiary" href="/">
            Return to the home page
          </ButtonLink>
        </Cluster>
      </StepUpFrame>
    );
  }
  return (
    <StepUpFrame title="Sign-in confirmation unavailable">
      <Alert tone="error" title="Could not be confirmed" role="alert">
        Whether this session is confirmed could not be checked right now. Please
        try again later.
      </Alert>
    </StepUpFrame>
  );
}
