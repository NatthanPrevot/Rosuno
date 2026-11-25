// The client's privacy and data page (MVP-001 S11 pass 2B; MBS section 18.2
// "privacy / data controls"; MVP-001 Packet rule 11: unapproved legal or
// regulatory text is never rendered).
//
// Rendered on the server for every request and never indexed. The verified
// client of the request decides access (the client intake sources); the
// database answers the counts of the categories of records the client's own
// account holds (Intakes, Requests, Consultations, uploaded documents, sent
// Messages, payment attempts and reported problems), never their content. No
// privacy text is approved yet, so the page repeats only the public privacy
// page's own words that the information is not yet available. PS-A6 section
// 3: the client submits a data request of one type (access, correction,
// deletion, export or restriction) with an optional description, sees their
// own requests with their state and decision, and withdraws one before its
// decision. The wording is neutral and fixed: no statement of rights,
// entitlements, timelines or retention (Packet rule 11). DEV-001: the
// owner's UI/UX design places the page in the client account's Settings,
// Privacy & data: the records the account holds, the data request form, the
// privacy notice row and the client's own privacy requests.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveClientDataRequests } from "../../../src/application/data-requests.ts";
import {
  DATA_CATEGORIES,
  resolveClientAccount,
} from "../../../src/application/participant-workspaces.ts";
import { getShellView } from "../../../src/application/shell.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../src/infrastructure/identity/server-session-source.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { CLIENT_DATA_REQUEST_SOURCES } from "../../../src/infrastructure/privacy/privacy-adapter.ts";
import { CLIENT_WORKSPACE_SOURCES } from "../../../src/infrastructure/workspaces/workspace-adapter.ts";
import {
  ClientAccount,
  ClientGate,
  ClientPill,
  ClientSettings,
  whenText,
} from "../../../src/presentation/client-account.tsx";
import { Alert, Text } from "../../../src/presentation/design-system.tsx";
import {
  DATA_REQUEST_NOTE,
  OUTCOME_LABELS,
  RECORDED_DECISION_LABEL,
  REQUEST_STATE_LABELS,
  REQUEST_TYPE_LABELS,
} from "../../../src/presentation/privacy-labels.ts";
import { SitePage } from "../../../src/presentation/site-chrome.tsx";
import {
  DATA_CATEGORY_LABELS,
  DATA_INTRO,
  PRIVACY_NOT_AVAILABLE,
} from "../../../src/presentation/workspace-labels.ts";
import { signOut } from "../../sign-in/actions.ts";
import { DataRequestForm, WithdrawRequestForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Privacy and data",
  robots: { index: false, follow: false },
};

export default async function ClientDataPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const shell = await getShellView(SUPABASE_SERVER_SESSION_SOURCE);
  const [view, requests] = await Promise.all([
    resolveClientAccount(CLIENT_WORKSPACE_SOURCES),
    resolveClientDataRequests(CLIENT_DATA_REQUEST_SOURCES),
  ]);
  if (view.status === "sign-in-required") {
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Sign in to continue">
          <p className="sm muted">
            This page is available only to its signed-in client.
          </p>
          <a className="btn btn-ink" href="/sign-in">
            Sign in
          </a>
        </ClientGate>
      </SitePage>
    );
  }
  if (view.status === "denied") {
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Privacy & data">
          <Alert tone="warning" title="Not available" role="status">
            This account does not have a client workspace.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "client_data.unavailable", {
      route: "/client/privacy",
      outcome: view.status,
    });
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Privacy & data">
          <Alert tone="error" title="Something went wrong" role="alert">
            This page could not be shown right now. Please try again later.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  return (
    <SitePage session={shell.session} signOut={signOut}>
      <ClientAccount area="settings" heading="Settings">
        <ClientSettings category="privacy" labelledBy="cx-set-h">
          <h2 className="cx-ct2" id="cx-set-h">
            Privacy & data
          </h2>
          <div className="cx-rows l-mt8">
            <div className="cx-srow">
              <div>
                <p className="cx-st">Records your account holds</p>
                <p className="cx-sd">{DATA_INTRO}</p>
              </div>
            </div>
            <div className="cx-rows" aria-label="Records your account holds">
              {DATA_CATEGORIES.map((category) => (
                <div className="cx-row" key={category}>
                  <span className="cx-k">{DATA_CATEGORY_LABELS[category]}</span>
                  <span className="cx-v">{view.account.counts[category]}</span>
                </div>
              ))}
            </div>
            <div className="cx-srow">
              <div>
                <p className="cx-st">Requests about your data</p>
                <p className="cx-sd">{DATA_REQUEST_NOTE}</p>
              </div>
            </div>
            <div className="cx-rc">
              <DataRequestForm />
            </div>
            <div className="cx-srow">
              <div>
                <p className="cx-st">Privacy notice</p>
                <Text>{PRIVACY_NOT_AVAILABLE}</Text>
              </div>
              <a className="btn btn-line btn-sm" href="/privacy">
                Read
              </a>
            </div>
          </div>
          <section aria-labelledby="cx-priv-h">
            <h3 className="cx-sgrp" id="cx-priv-h">
              Your privacy requests
            </h3>
            {requests.status !== "ready" ? (
              <Alert tone="error" title="Something went wrong" role="alert">
                Your requests could not be shown right now. Please try again
                later.
              </Alert>
            ) : requests.requests.length === 0 ? (
              <p className="cx-sd rz-cx-none">
                You have not made a request about your data.
              </p>
            ) : (
              requests.requests.map((request) => (
                <div className="cx-srow" key={request.id}>
                  <div>
                    <p className="cx-st">{REQUEST_TYPE_LABELS[request.type]}</p>
                    <p className="cx-sd">
                      {`Submitted ${whenText(request.submittedAt)}`}
                    </p>
                    {request.details === null ? null : (
                      <p className="cx-sd">{`Your details: ${request.details}`}</p>
                    )}
                    {request.decidedAt === null ? null : (
                      <p className="cx-sd">
                        {`Decided ${whenText(request.decidedAt)}`}
                      </p>
                    )}
                    {request.outcome === null ? null : (
                      <p className="cx-sd">
                        {`${RECORDED_DECISION_LABEL}: ${OUTCOME_LABELS[request.outcome]}`}
                      </p>
                    )}
                  </div>
                  <span className="row l-g8-fwrwrap-jcflex-end">
                    <ClientPill tone={REQUEST_STATE_LABELS[request.state].tone}>
                      {REQUEST_STATE_LABELS[request.state].label}
                    </ClientPill>
                    {request.state === "submitted" ||
                    request.state === "in_review" ? (
                      <WithdrawRequestForm request={request.id} />
                    ) : null}
                  </span>
                </div>
              ))
            )}
          </section>
        </ClientSettings>
      </ClientAccount>
    </SitePage>
  );
}
