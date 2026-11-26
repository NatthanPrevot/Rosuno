// Attorney application entry (P3-002).
//
// Rendered on the server for every request: the trusted server session, a
// fresh read of the request's own Auth user, and that account's own records,
// read without any privileged credential, decide which fixed state the page
// shows. The page only reads; the one form posts an explicit start request
// to the server action, which decides afresh on the server. The page reads no
// route parameter, query, header, cookie, or form field of its own. A
// visitor who is not signed in sees informational content and the existing
// sign-in only: no account is created here. The start form is offered only
// when the privileged start boundary is configured, checked without building
// it (P3-003), so a start that would certainly fail is never offered. Every refusal reason shows the
// same fixed message, and no state shows an identifier or record. Starting an
// application records an applicant stage only; this page establishes no
// professional verification, approval, or eligibility.
//
// DEV-001: the owner's UI/UX design (UIUX-HANDOFF-P2 build_p8,
// Apply.dc.html): the application page on the design's paper background,
// with the breadcrumb back to For attorneys, the page title, and the
// design's steps beside the step card (starting the application here, the
// professional details in professional setup, then Rosuno's review). The
// one start form and every fixed state are unchanged.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  ATTORNEY_APPLICATION_INTENT,
  resolveAttorneyApplicationEntry,
} from "../../../src/application/attorney-application.ts";
import {
  ATTORNEY_APPLICANT_START_CONFIGURED,
  ATTORNEY_APPLICATION_ACCOUNT,
  ATTORNEY_APPLICATION_RECORDS,
} from "../../../src/infrastructure/identity/attorney-application-provisioning.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../src/infrastructure/identity/server-session-source.ts";
import {
  Alert,
  Button,
  ButtonLink,
  Cluster,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { startApplication } from "./actions.ts";

export const metadata: Metadata = {
  title: "Attorney application",
  robots: { index: false, follow: false },
};

type ApplicationFrameProps = {
  readonly title: string;
  // The design's steps, shown once the account may hold an application:
  // where this page is in them (the start is current, or done once on
  // record).
  readonly steps?: "start" | "on-record";
  readonly children: ReactNode;
};

// The design's application steps, in order. Only the first is taken here.
const STEPS = Object.freeze([
  "Start your application",
  "Professional details",
  "Review by Rosuno",
] as const);

function ApplicationFrame({ title, steps, children }: ApplicationFrameProps) {
  return (
    <div className="rz l-bgpaper-minh100vh rz-apply">
      <div className="wrap ap-wrap l-pt32-pb88-mw1200">
        <nav className="crumbs" aria-label="Breadcrumb">
          <a href="/for-attorneys">For attorneys</a>
          <span aria-hidden="true">/</span>
          <span className="l-cink" aria-current="page">
            Apply
          </span>
        </nav>
        <div className="row between ap-title l-mt12-aiflex-end">
          <h1 className="h2 ap-h1 l-fs38" id="attorney-application-title">
            {title}
          </h1>
        </div>
        {steps === undefined ? (
          <section
            className="panel ap-sec l-p30-34 rz-ap-sec rz-ap-solo"
            aria-labelledby="attorney-application-title"
          >
            {children}
          </section>
        ) : (
          <div className="ap-grid l-dgrid-cols260-mm0-1fr-g24-mt24-aistart">
            <aside
              className="panel ap-aside l-p12-possticky-t16"
              aria-label="Application steps"
            >
              <ol className="vsteps">
                {STEPS.map((step, index) => (
                  <li
                    key={step}
                    className={
                      index === 0
                        ? steps === "start"
                          ? "vstep cur"
                          : "vstep done"
                        : "vstep"
                    }
                    aria-current={
                      index === 0 && steps === "start" ? "step" : undefined
                    }
                  >
                    <span className="sn">
                      {index === 0 && steps === "on-record" ? "✓" : index + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
              <p className="xs subtle l-p10-10-4">
                One application is kept per account.
              </p>
            </aside>
            <section
              className="panel ap-sec l-p30-34 rz-ap-sec"
              aria-labelledby="attorney-application-title"
            >
              <p className="kicker">
                <span>
                  {steps === "start" ? "Step 1 of 3" : "Step 1 of 3 · done"}
                </span>
              </p>
              {children}
            </section>
          </div>
        )}
      </div>
    </div>
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
  await requireSteppedUp("attorney");
  const entry = await resolveAttorneyApplicationEntry({
    session: SUPABASE_SERVER_SESSION_SOURCE,
    account: ATTORNEY_APPLICATION_ACCOUNT,
    records: ATTORNEY_APPLICATION_RECORDS,
    startConfigured: ATTORNEY_APPLICANT_START_CONFIGURED,
  });
  if (entry.status === "can-start") {
    return (
      <ApplicationFrame title="Start an attorney application" steps="start">
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
      <ApplicationFrame
        title="Attorney application on record"
        steps="on-record"
      >
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
