// Attorney application entry (P3-002).
//
// Rendered on the server for every request: the trusted server session, a
// fresh read of the request's own Auth user, and that account's own records,
// read without any privileged credential, decide which fixed state the page
// shows. The page only reads; the one form posts an explicit start request
// to the server action, which decides afresh on the server. The page reads no
// route parameter, query, header, cookie, or form field of its own. A
// visitor who is not signed in sees informational content and the existing
// sign-in only: no account is created here. Every refusal reason shows the
// same fixed message, and no state shows an identifier or record. Starting an
// application records an applicant stage only; this page establishes no
// professional verification, approval, or eligibility.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  ATTORNEY_APPLICATION_INTENT,
  resolveAttorneyApplicationEntry,
} from "../../../src/application/attorney-application.ts";
import {
  ATTORNEY_APPLICATION_ACCOUNT,
  ATTORNEY_APPLICATION_RECORDS,
} from "../../../src/infrastructure/identity/attorney-application-provisioning.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../src/infrastructure/identity/server-session-source.ts";
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
} from "../../../src/presentation/design-system.tsx";
import { startApplication } from "./actions.ts";

export const metadata: Metadata = {
  title: "Attorney application",
  robots: { index: false, follow: false },
};

type ApplicationFrameProps = {
  readonly title: string;
  readonly children: ReactNode;
};

function ApplicationFrame({ title, children }: ApplicationFrameProps) {
  return (
    <Page density="attorney">
      <Surface emphasis="raised" labelledBy="attorney-application-title">
        <Stack>
          <Eyebrow>Attorney application</Eyebrow>
          <Heading as="h1" size="lg" id="attorney-application-title">
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

// What starting an application does and does not do, in fixed words.
function ApplicationMeaning() {
  return (
    <Alert tone="information" title="An application is not verification">
      Starting an application records an attorney profile for your account in
      the applicant stage. It does not establish professional verification,
      approve you, or decide whether you may be offered to clients. Those are
      separate steps that this page does not take.
    </Alert>
  );
}

function ReturnHome() {
  return (
    <ButtonLink variant="tertiary" href="/">
      Return to the home page
    </ButtonLink>
  );
}

export default async function AttorneyApplicationPage() {
  // The entry belongs to each request on the server; never prerender or
  // cache it.
  await connection();
  const entry = await resolveAttorneyApplicationEntry({
    session: SUPABASE_SERVER_SESSION_SOURCE,
    account: ATTORNEY_APPLICATION_ACCOUNT,
    records: ATTORNEY_APPLICATION_RECORDS,
  });
  if (entry.status === "can-start") {
    return (
      <ApplicationFrame title="Start an attorney application">
        <Text tone="muted">
          Your signed-in account can start an attorney application. One
          application is kept per account, so starting it again never creates
          another.
        </Text>
        <ApplicationMeaning />
        <form action={startApplication}>
          <input
            type="hidden"
            name={ATTORNEY_APPLICATION_INTENT.field}
            value={ATTORNEY_APPLICATION_INTENT.value}
          />
          <Cluster>
            <Button variant="primary" type="submit">
              Start attorney application
            </Button>
            <ReturnHome />
          </Cluster>
        </form>
      </ApplicationFrame>
    );
  }
  if (entry.status === "on-record") {
    return (
      <ApplicationFrame title="Attorney application on record">
        <Alert tone="success" title="Application on record" role="status">
          This account has an attorney application. Another cannot be started,
          and the existing application is unchanged.
        </Alert>
        <Text tone="muted">
          The attorney workspace shows the application&apos;s current stage.
        </Text>
        <ApplicationMeaning />
        <Cluster>
          <ButtonLink variant="primary" href="/attorney">
            Open the attorney workspace
          </ButtonLink>
          <ReturnHome />
        </Cluster>
      </ApplicationFrame>
    );
  }
  if (entry.status === "sign-in-required") {
    return (
      <ApplicationFrame title="Attorney application">
        <Text tone="muted">
          Attorneys apply with an existing Rosuno account whose email address is
          confirmed. Sign in with that account to see whether an application can
          be started.
        </Text>
        <ApplicationMeaning />
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
          <ReturnHome />
        </Cluster>
      </ApplicationFrame>
    );
  }
  if (entry.status === "denied") {
    return (
      <ApplicationFrame title="Attorney application not available">
        <Alert
          tone="warning"
          title="No application can be started"
          role="status"
        >
          An attorney application cannot be started for this account. Any other
          access the account has is unchanged.
        </Alert>
        <Cluster>
          <ReturnHome />
        </Cluster>
      </ApplicationFrame>
    );
  }
  return (
    <ApplicationFrame title="Attorney application unavailable">
      <Alert
        tone="error"
        title="The application could not be checked"
        role="alert"
      >
        Whether an attorney application can be started could not be confirmed
        right now. Please try again later.
      </Alert>
      <Cluster>
        <ReturnHome />
      </Cluster>
    </ApplicationFrame>
  );
}
