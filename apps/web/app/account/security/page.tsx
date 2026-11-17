// Authenticator setup for attorney and staff accounts (MVP-001 S2).
//
// Rendered on the server for every request. The trusted session, a fresh
// read of the request's own Auth account, its active User and its own
// Staff and Attorney Profiles decide whether this is an attorney or staff
// principal, and a fresh read of the session's assurance decides which
// fixed state is shown: set up an authenticator app, confirm a code from the
// one already set up, or continue. The one query value read, to, only says
// which of the principal's own workspaces to return to; the server checks it
// against the principal's own kinds and returns only to a fixed address. The
// page reads no route parameter, header, or cookie of its own, and shows no
// factor, key, or provider detail beyond what the setup form itself returns.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  ACCOUNT_PAGES,
  STEP_UP_DESTINATIONS,
} from "../../../src/application/session-assurance.ts";
import { resolveAccountSecurity } from "../../../src/application/totp-step-up.ts";
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
import { EnrollmentForms } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Sign-in security",
  robots: { index: false, follow: false },
};

function SecurityFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="public">
      <Surface emphasis="raised" labelledBy="account-security-title">
        <Stack>
          <Eyebrow>Sign-in security</Eyebrow>
          <Heading as="h1" size="lg" id="account-security-title">
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

export default async function AccountSecurityPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly to?: string | string[] }>;
}) {
  // Assurance belongs to each request on the server; never prerender or
  // cache it.
  await connection();
  const { to } = await searchParams;
  const view = await resolveAccountSecurity(AUTHENTICATOR_SOURCES, to);
  if (view.status === "set-up") {
    return (
      <SecurityFrame title="Set up an authenticator app">
        <Text tone="muted">
          Attorney and staff accounts confirm each sign-in with a 6-digit code
          from an authenticator app on a device you keep with you. Set one up
          now to continue.
        </Text>
        <EnrollmentForms kind={view.kind} />
      </SecurityFrame>
    );
  }
  if (view.status === "step-up-required") {
    return (
      <SecurityFrame title="Authenticator app set up">
        <Text tone="muted">
          An authenticator app is set up for this account. Confirm a code from
          it to continue.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href={ACCOUNT_PAGES[view.kind].stepUp}>
            Confirm a code
          </ButtonLink>
        </Cluster>
      </SecurityFrame>
    );
  }
  if (view.status === "protected") {
    return (
      <SecurityFrame title="Sign-in confirmed">
        <Alert tone="success" title="Authenticator app set up" role="status">
          This session is confirmed with a code from your authenticator app.
        </Alert>
        <Cluster>
          <ButtonLink variant="primary" href={STEP_UP_DESTINATIONS[view.kind]}>
            Continue
          </ButtonLink>
        </Cluster>
      </SecurityFrame>
    );
  }
  if (view.status === "sign-in-required") {
    return (
      <SecurityFrame title="Sign in to continue">
        <Text tone="muted">
          Sign-in security is available only to a signed-in attorney or staff
          account.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </SecurityFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <SecurityFrame title="Sign-in security not available">
        <Alert tone="warning" title="Not available" role="status">
          This is available only to attorney and staff accounts. Any other
          access the account has is unchanged.
        </Alert>
        <Cluster>
          <ButtonLink variant="tertiary" href="/">
            Return to the home page
          </ButtonLink>
        </Cluster>
      </SecurityFrame>
    );
  }
  return (
    <SecurityFrame title="Sign-in security unavailable">
      <Alert tone="error" title="Could not be opened" role="alert">
        Sign-in security could not be opened right now. Please try again later.
      </Alert>
    </SecurityFrame>
  );
}
