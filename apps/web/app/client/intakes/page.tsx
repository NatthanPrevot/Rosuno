// The client's legal matters: the Intakes list (P5-001; MVP-001 D-3;
// DEV-001: the owner's UI/UX design, the client account's Legal matters).
//
// Rendered on the server for every request: the trusted server session, the
// trusted client principal source and the Security Shell decide access, and
// the client's own Intakes are read through the request's own session under
// the database's row policies. The one query value read, page, only asks
// which page of the client's own Intakes to show (newest first); the server
// checks it and shows the first page for anything else. The page reads no
// route parameter, header, cookie, or form field of its own. When a page
// does not hold every Intake, it says so and links to its neighbours, so no
// Intake is left out unseen. Each Intake opens its own page; the start form
// posts to the existing start action. Refused and unavailable requests each
// see one fixed message and no Intake data; an unavailable list also writes
// one log line with no client or Intake data.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveClientWorkspace } from "../../../src/application/client-intake.ts";
import { getShellView } from "../../../src/application/shell.ts";
import { CLIENT_INTAKE_SOURCES } from "../../../src/infrastructure/client/client-intake-adapter.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../src/infrastructure/identity/server-session-source.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import {
  ClientAccount,
  ClientGate,
  ClientPill,
  NotAvailableYet,
  dateText,
} from "../../../src/presentation/client-account.tsx";
import { INTAKE_STATE_LABELS } from "../../../src/presentation/client-intake-labels.ts";
import { Alert } from "../../../src/presentation/design-system.tsx";
import { SitePage } from "../../../src/presentation/site-chrome.tsx";
import { signOut } from "../../sign-in/actions.ts";
import { StartIntakeForm } from "../forms.tsx";

export const metadata: Metadata = {
  title: "Legal matters",
  robots: { index: false, follow: false },
};

function pageHref(page: number): string {
  return page === 1 ? "/client/intakes" : `/client/intakes?page=${page}`;
}

export default async function ClientIntakesPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string | string[] }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const shell = await getShellView(SUPABASE_SERVER_SESSION_SOURCE);
  const { page } = await searchParams;
  const view = await resolveClientWorkspace(CLIENT_INTAKE_SOURCES, page);
  if (view.status === "sign-in-required") {
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Sign in to continue">
          <p className="sm muted">Sign in to see your legal matters.</p>
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
        <ClientGate heading="Client workspace unavailable">
          <Alert
            tone="error"
            title="Not available for this account"
            role="alert"
          >
            The client workspace is available to signed-in client accounts.
          </Alert>
          <a className="cx-link" href="/">
            Return to the home page
          </a>
        </ClientGate>
      </SitePage>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "client_workspace.unavailable", {
      route: "/client/intakes",
      outcome: view.status,
    });
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Legal matters unavailable">
          <Alert tone="error" title="Something went wrong" role="alert">
            Your legal matters could not be shown. Please try again later.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  const first = (view.page - 1) * view.pageSize + 1;
  const last = first + view.intakes.length - 1;
  const paged = view.newerPage !== null || view.olderPage !== null;
  return (
    <SitePage session={shell.session} signOut={signOut}>
      <ClientAccount area="matters" heading="Legal matters">
        {view.intakes.length === 0 && view.page === 1 ? null : (
          <div className="cx-tools l-fwrwrap-g10">
            <p className="sm muted">
              {view.intakes.length === 0
                ? "No legal matters on this page"
                : paged
                  ? `Legal matters ${first} to ${last}, newest first`
                  : view.intakes.length === 1
                    ? "1 legal matter"
                    : `${view.intakes.length} legal matters`}
            </p>
            {view.canStart ? <StartIntakeForm /> : null}
          </div>
        )}
        <p className="xs subtle l-mt6-mw640">
          Each matter keeps what you told us and every update you make. Every
          time you save, a new version is kept; earlier versions are never
          changed or deleted. Dates are in UTC.
        </p>
        {view.canStart ? null : (
          <NotAvailableYet
            title="Starting a new matter"
            reason="new legal matters cannot be started right now. Please come back later."
          />
        )}
        {view.intakes.length === 0 && view.page === 1 ? (
          <section
            className="cx-card l-mt18-p40-28-dflex-fdcolumn-aicente-8ccc4d"
            aria-labelledby="lm-empty-h"
          >
            <h2 className="h4" id="lm-empty-h">
              No legal matters yet
            </h2>
            <p className="sm muted l-mt4-mw460">
              When you use Help me find an attorney, your answers become a legal
              matter you can keep, update and share with the attorneys you
              choose.
            </p>
            {view.canStart ? (
              <div className="l-mt16">
                <StartIntakeForm prominent />
              </div>
            ) : null}
          </section>
        ) : null}
        {view.intakes.length === 0 && view.page > 1 ? (
          <section
            className="cx-card l-mt18-p40-28-dflex-fdcolumn-aicente-8ccc4d"
            aria-labelledby="lm-none-h"
          >
            <h2 className="h4" id="lm-none-h">
              There are no legal matters on this page
            </h2>
            <a className="btn btn-line btn-sm l-mt16" href="/client/intakes">
              Show your most recent legal matters
            </a>
          </section>
        ) : null}
        {view.intakes.length === 0 ? null : (
          <ul
            className="stack l-g10-mt14-p0-lstnone"
            aria-label="Your legal matters"
          >
            {view.intakes.map((intake) => {
              const state = INTAKE_STATE_LABELS[intake.state];
              return (
                <li key={intake.id}>
                  <a
                    className="cx-card l-dflex-w100pc-p16-20-g12-aicenter-j-730d17 rz-cx-row"
                    href={`/client/intakes/${intake.id}`}
                  >
                    <span className="stack l-g2-minw0">
                      <span className="sm l-fw600 rz-cx-rt">
                        {`Legal matter started ${dateText(intake.createdAt)}`}
                      </span>
                      <span className="xs subtle">
                        {intake.lastSavedAt === null
                          ? "Not saved yet"
                          : `Version ${intake.revisions} · Updated ${dateText(intake.lastSavedAt)}`}
                      </span>
                    </span>
                    <ClientPill tone={state.tone}>{state.label}</ClientPill>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
        {view.intakes.length > 0 && paged ? (
          <div className="cx-tools l-mt14">
            <p className="xs subtle">
              {view.olderPage === null
                ? "There are no older legal matters."
                : "Older legal matters are on the next page."}
            </p>
            <div className="row l-g8">
              {view.newerPage === null ? null : (
                <a
                  className="btn btn-line btn-sm"
                  href={pageHref(view.newerPage)}
                >
                  Show newer legal matters
                </a>
              )}
              {view.olderPage === null ? null : (
                <a
                  className="btn btn-line btn-sm"
                  href={pageHref(view.olderPage)}
                >
                  Show older legal matters
                </a>
              )}
            </div>
          </div>
        ) : null}
      </ClientAccount>
    </SitePage>
  );
}
