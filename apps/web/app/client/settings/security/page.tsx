// The client's account security (DEV-001: the owner's UI/UX design, the
// client account's Settings, Account security; MBS section 18.2 "profile /
// settings").
//
// Rendered on the server for every request and never indexed. The verified
// client of the request decides access (the client intake sources, through
// the existing account overview read); nothing else is read and nothing here
// changes anything. A client account signs in with its email address and
// password: the page says where the existing password reset starts. Two-step
// sign-in (the authenticator setup page serves attorney and staff accounts
// only), the signed-in devices and the account activity of the design have
// no record for a client yet, so each shows the design's "Not available yet"
// state.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveClientAccount } from "../../../../src/application/participant-workspaces.ts";
import { getShellView } from "../../../../src/application/shell.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../../src/infrastructure/identity/server-session-source.ts";
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
import { CLIENT_WORKSPACE_SOURCES } from "../../../../src/infrastructure/workspaces/workspace-adapter.ts";
import {
  ClientAccount,
  ClientGate,
  ClientSettings,
  NotAvailableYet,
} from "../../../../src/presentation/client-account.tsx";
import { Alert } from "../../../../src/presentation/design-system.tsx";
import { SitePage } from "../../../../src/presentation/site-chrome.tsx";
import { SIGN_IN_SECURITY_NOTE } from "../../../../src/presentation/workspace-labels.ts";
import { signOut } from "../../../sign-in/actions.ts";

export const metadata: Metadata = {
  title: "Account security",
  robots: { index: false, follow: false },
};

export default async function ClientSecurityPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const shell = await getShellView(SUPABASE_SERVER_SESSION_SOURCE);
  const view = await resolveClientAccount(CLIENT_WORKSPACE_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Sign in to continue">
          <p className="sm muted">
            Your settings are available only to their signed-in client.
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
        <ClientGate heading="Settings unavailable">
          <Alert tone="warning" title="Not available" role="status">
            This account does not have client settings.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "client_settings.unavailable", {
      route: "/client/settings/security",
      outcome: view.status,
    });
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Settings unavailable">
          <Alert tone="error" title="Something went wrong" role="alert">
            Your settings could not be shown right now. Please try again later.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  return (
    <SitePage session={shell.session} signOut={signOut}>
      <ClientAccount area="settings" heading="Settings">
        <ClientSettings category="security" labelledBy="cx-set-h">
          <h2 className="cx-ct2" id="cx-set-h">
            Account security
          </h2>
          <div className="cx-rows l-mt8">
            <div className="cx-srow">
              <div>
                <p className="cx-st">Password</p>
                <p className="cx-sd">{SIGN_IN_SECURITY_NOTE}</p>
              </div>
            </div>
            <div className="cx-srow">
              <div>
                <p className="cx-st">Two-step sign-in</p>
                <p className="cx-sd">
                  Not available yet — two-step sign-in is offered to attorney
                  and staff accounts.
                </p>
              </div>
              <span className="tag">Not available</span>
            </div>
          </div>
          <p className="cx-sgrp">Signed-in devices</p>
          <NotAvailableYet
            reason="your account does not list its signed-in devices yet. Use Sign out at the top of the page to sign out of this browser."
            placeholder="[session length and sign-out rules — per security policy]"
          />
          <p className="cx-sgrp">Recent account activity</p>
          <NotAvailableYet reason="your account does not list its sign-in activity yet." />
        </ClientSettings>
      </ClientAccount>
    </SitePage>
  );
}
