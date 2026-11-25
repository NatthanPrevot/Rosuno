// The client's profile and settings (MVP-001 S11 pass 2B; MBS section 18.2
// "profile / settings").
//
// Rendered on the server for every request and never indexed. The verified
// client of the request decides access (the client intake sources); the
// database answers the client's own account: the display name, the account
// state and since when the account exists. No database function lets a
// client change the display name, so nothing here changes anything. Sign-in
// security for a client account is its password: the page says where the
// existing password reset starts (the sign-in page) and links the
// notification center. The authenticator setup page serves attorney and
// staff accounts only, so it is not linked here. DEV-001: the owner's UI/UX
// design, the client account's My profile: the personal details and what
// Rosuno manages, read-only (the design's edit forms have no write here). The
// sign-in security note is on the Account security page.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveClientAccount } from "../../../src/application/participant-workspaces.ts";
import { getShellView } from "../../../src/application/shell.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../src/infrastructure/identity/server-session-source.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { CLIENT_WORKSPACE_SOURCES } from "../../../src/infrastructure/workspaces/workspace-adapter.ts";
import {
  ClientAccount,
  ClientGate,
  NotAvailableYet,
  dateText,
} from "../../../src/presentation/client-account.tsx";
import { Alert } from "../../../src/presentation/design-system.tsx";
import { SitePage } from "../../../src/presentation/site-chrome.tsx";
import {
  ACCOUNT_STATE_LABELS,
  NO_DISPLAY_NAME,
  SETTINGS_INTRO,
} from "../../../src/presentation/workspace-labels.ts";
import { signOut } from "../../sign-in/actions.ts";

export const metadata: Metadata = {
  title: "My profile",
  robots: { index: false, follow: false },
};

export default async function ClientSettingsPage() {
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
        <ClientGate heading="My profile">
          <Alert tone="warning" title="Not available" role="status">
            This account does not have client settings.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "client_settings.unavailable", {
      route: "/client/settings",
      outcome: view.status,
    });
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="My profile">
          <Alert tone="error" title="Something went wrong" role="alert">
            Your settings could not be shown right now. Please try again later.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  const state = ACCOUNT_STATE_LABELS[view.account.accountState];
  return (
    <SitePage session={shell.session} signOut={signOut}>
      <ClientAccount area="profile" heading="My profile">
        <div className="cx-prof">
          <div className="cx-col">
            <section className="cx-card cx-pcard" aria-labelledby="cx-pn-h">
              <div className="cx-ch">
                <h2 className="cx-ct2" id="cx-pn-h">
                  Personal details
                </h2>
              </div>
              <div className="cx-rows">
                <div className="cx-row">
                  <span className="cx-k">Name</span>
                  <span
                    className={
                      view.account.displayName === null ? "cx-v empty" : "cx-v"
                    }
                  >
                    {view.account.displayName ?? NO_DISPLAY_NAME}
                  </span>
                </div>
              </div>
              <p className="cx-note">{SETTINGS_INTRO}</p>
            </section>
            <section className="cx-card cx-pcard" aria-labelledby="cx-pc-h">
              <div className="cx-ch">
                <h2 className="cx-ct2" id="cx-pc-h">
                  Contact details
                </h2>
              </div>
              <NotAvailableYet reason="your email address and phone number are not shown here yet." />
            </section>
          </div>
          <aside className="cx-managed" aria-labelledby="cx-pm-h">
            <h2 className="cx-mh" id="cx-pm-h">
              Managed by Rosuno
            </h2>
            <div className="cx-mrow">
              <span className="muted">Account type</span>
              <span>Client</span>
            </div>
            <div className="cx-mrow">
              <span className="muted">Account state</span>
              <span>{state.label}</span>
            </div>
            <div className="cx-mrow">
              <span className="muted">Account created</span>
              <span>{dateText(view.account.createdAt)}</span>
            </div>
            <div className="cx-mrow">
              <span className="muted">Time zone</span>
              <span>Times shown in UTC</span>
            </div>
            <div className="cx-mrow">
              <span className="muted">Sign-in</span>
              <span>Email and password</span>
            </div>
            <a
              className="cx-link l-mt12-fs13_5 l-dblock"
              href="/client/settings/security"
            >
              Sign-in and security
            </a>
          </aside>
        </div>
      </ClientAccount>
    </SitePage>
  );
}
