// Protected client workspace overview (P5-001; MVP-001 S11 pass 2B, MBS
// section 18.2 "home / dashboard"; DEV-001: the owner's UI/UX design, the
// client account's Overview).
//
// Rendered on the server for every request: the trusted server session, the
// trusted client principal source and the Security Shell decide access, and
// the client's own Consultations are read through the request's own session
// under the database's row policies (the existing S11 read, decided again by
// the database). The page reads no route parameter, query value, header,
// cookie, or form field of its own. An admitted client sees the Consultation
// in progress or ready now, or else the next upcoming one, as the design's
// next-consultation card (or the design's "No upcoming consultations" and
// first-visit states), and the recent activity from the client's own
// notification center (the existing S10 read). The client's Intakes are
// listed on the Legal matters page. Refused and unavailable requests each see
// one fixed message and no data; an unavailable workspace also writes one log
// line with no client data. Nothing about the attorney is shown: no read
// gives it to the client's lists yet.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  clientDisplayStateOf,
  resolveClientConsultations,
  type ClientConsultationEntry,
} from "../../src/application/consultation-outcomes.ts";
import {
  resolveClientNotifications,
  type CenterEntry,
} from "../../src/application/notification-center.ts";
import { clientHomeOf } from "../../src/application/participant-workspaces.ts";
import { getShellView } from "../../src/application/shell.ts";
import { CLIENT_CENTER_SOURCES } from "../../src/infrastructure/communications/communication-adapter.ts";
import { CLIENT_OUTCOME_SOURCES } from "../../src/infrastructure/consultations/completion-adapter.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../src/infrastructure/identity/server-session-source.ts";
import { logRequestEvent } from "../../src/infrastructure/observability/request-log.ts";
import {
  ClientAccount,
  ClientGate,
  ClientPill,
  ConsultationTile,
  ModalityIcon,
  clockText,
  dayText,
  monthDayText,
} from "../../src/presentation/client-account.tsx";
import { NOTIFICATION_LABELS } from "../../src/presentation/communication-labels.ts";
import {
  CLIENT_STATE_LABELS,
  durationText,
  modalityText,
  PATH_LABELS,
} from "../../src/presentation/consultation-labels.ts";
import { Alert } from "../../src/presentation/design-system.tsx";
import { SitePage } from "../../src/presentation/site-chrome.tsx";
import { SECTION_UNAVAILABLE } from "../../src/presentation/workspace-labels.ts";
import { signOut } from "../sign-in/actions.ts";

export const metadata: Metadata = {
  title: "Client workspace",
  robots: { index: false, follow: false },
};

// The design's recent activity shows the latest few entries; the full list
// is the notification center.
const RECENT_ACTIVITY = 5;

function NextConsultation({
  entry,
  current,
}: {
  readonly entry: ClientConsultationEntry;
  readonly current: boolean;
}) {
  const state = CLIENT_STATE_LABELS[clientDisplayStateOf(entry)];
  return (
    <section className="cx-card cx-next" aria-labelledby="cx-next-h">
      <ConsultationTile modality={entry.modality} size="next" />
      <div className="cx-next-main">
        <div className="cx-next-top">
          <h2 className="cx-eyebrow" id="cx-next-h">
            {current ? "Current consultation" : "Next consultation"}
          </h2>
          <ClientPill tone={state.tone}>{state.label}</ClientPill>
        </div>
        {entry.bookingStart === null ? (
          <p className="cx-when">
            <span className="nw">{PATH_LABELS[entry.path]}</span>
          </p>
        ) : (
          <p className="cx-when">
            <span className="nw">{dayText(entry.bookingStart)}</span>
            <span className="t nw">{` · ${clockText(entry.bookingStart)}`}</span>
          </p>
        )}
        <p className="cx-next-meta">
          {entry.durationMinutes === null ? null : (
            <>
              <span className="nw">{durationText(entry.durationMinutes)}</span>
              <span className="cx-sep">·</span>
            </>
          )}
          <span className="nw cux-ty">
            <ModalityIcon modality={entry.modality} />
            <span>{modalityText(entry.modality)}</span>
          </span>
        </p>
      </div>
      <div className="cx-next-act">
        <a className="btn btn-ink" href={`/client/consultations/${entry.id}`}>
          View details
        </a>
      </div>
    </section>
  );
}

function ActivityItem({ entry }: { readonly entry: CenterEntry }) {
  const label = NOTIFICATION_LABELS[entry.type];
  const attention =
    entry.acknowledgementRequired && entry.state !== "acknowledged";
  const text = (
    <>
      <span className="cx-at">{label}</span>
      <span className="cx-aw">{monthDayText(entry.createdAt)}</span>
    </>
  );
  return (
    <div className={attention ? "cx-act unread" : "cx-act"}>
      <span className="cx-adot" aria-hidden="true" />
      {entry.linkPath === null ? (
        <span className="cx-abtn">{text}</span>
      ) : (
        <a className="cx-abtn" href={entry.linkPath}>
          {text}
        </a>
      )}
      {entry.type === "review_available" ? (
        <a className="btn btn-line btn-sm" href="/client/reviews">
          Leave a review
        </a>
      ) : null}
    </div>
  );
}

export default async function ClientWorkspacePage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const shell = await getShellView(SUPABASE_SERVER_SESSION_SOURCE);
  const view = await resolveClientConsultations(CLIENT_OUTCOME_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Sign in to continue">
          <p className="sm muted">Sign in to see your account.</p>
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
      route: "/client",
      outcome: view.status,
    });
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Client workspace unavailable">
          <Alert tone="error" title="Something went wrong" role="alert">
            Your workspace could not be shown. Please try again later.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  const home = clientHomeOf(view, Date.now());
  const focus = home === null ? null : (home.active[0] ?? home.next);
  const center = await resolveClientNotifications(CLIENT_CENTER_SOURCES);
  if (center.status !== "ready") {
    await logRequestEvent("warn", "client_workspace.unavailable", {
      route: "/client",
      operation: "resolveClientNotifications",
      outcome: center.status,
    });
  }
  const activity =
    center.status === "ready" ? center.entries.slice(0, RECENT_ACTIVITY) : [];
  const firstVisit =
    view.entries.length === 0 &&
    center.status === "ready" &&
    center.entries.length === 0;
  return (
    <SitePage session={shell.session} signOut={signOut}>
      <ClientAccount area="overview" heading="Overview">
        <div className="cx-ov2">
          {home === null ? (
            <section className="cx-card cx-none" aria-labelledby="cx-none-h">
              <div>
                <h2 className="cx-ct2" id="cx-none-h">
                  Your consultations
                </h2>
                <p className="sm muted l-mt4">
                  Your consultations could not be shown right now.
                </p>
              </div>
            </section>
          ) : focus !== null ? (
            <NextConsultation entry={focus} current={home.active.length > 0} />
          ) : firstVisit ? (
            <section
              className="cx-card cx-empty-hero"
              aria-labelledby="cx-start-h"
            >
              <div>
                <p className="cx-eyebrow">Welcome to Rosuno</p>
                <h2 className="h3 l-mt8" id="cx-start-h">
                  Let’s find you the right attorney
                </h2>
                <p className="sm muted l-mt8-mw420">
                  Browse attorneys, or answer a few questions about your matter.
                  You choose who to contact.
                </p>
                <div className="row l-g10-mt20-fwrwrap">
                  <a className="btn btn-ink" href="/client/intakes">
                    Help me find an attorney
                  </a>
                  <a className="btn btn-line" href="/find-an-attorney">
                    Browse attorneys
                  </a>
                </div>
              </div>
              <ol className="cx-steps" aria-label="How a consultation works">
                <li className="cx-step">
                  <b>1</b>
                  <span>
                    Send a request — now, or for a time that suits you.
                  </span>
                </li>
                <li className="cx-step">
                  <b>2</b>
                  <span>
                    The attorney accepts or declines. Nothing is booked until
                    they accept.
                  </span>
                </li>
                <li className="cx-step">
                  <b>3</b>
                  <span>Meet by video or audio call in your browser.</span>
                </li>
              </ol>
            </section>
          ) : (
            <section className="cx-card cx-none" aria-labelledby="cx-none-h">
              <div>
                <h2 className="cx-ct2" id="cx-none-h">
                  No upcoming consultations
                </h2>
                <p className="sm muted l-mt4">
                  When an attorney accepts a request, it appears here.
                </p>
              </div>
              <a className="btn btn-ink" href="/find-an-attorney">
                Find an attorney
              </a>
            </section>
          )}
          {firstVisit ? null : (
            <div className="cx-ov2-row one">
              <section className="cx-card cx-sec" aria-labelledby="cx-act-h">
                <div className="cx-ch">
                  <h2 className="cx-ct2" id="cx-act-h">
                    Recent activity
                  </h2>
                  <a className="cx-link" href="/client/consultations?show=past">
                    Past consultations
                  </a>
                </div>
                {center.status !== "ready" ? (
                  <p className="cx-once">{SECTION_UNAVAILABLE}</p>
                ) : activity.length === 0 ? (
                  <p className="cx-once">No recent activity.</p>
                ) : (
                  <div className="cx-list2">
                    {activity.map((entry) => (
                      <ActivityItem key={entry.id} entry={entry} />
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
        <nav className="rz-cx-links" aria-label="More in your account">
          <a className="cx-link" href="/client/messages">
            Messages
          </a>
          <a className="cx-link" href="/client/reviews">
            Your reviews
          </a>
          <a className="cx-link" href="/client/notifications">
            All notifications
          </a>
          <a className="cx-link" href="/client/privacy">
            Privacy & data
          </a>
        </nav>
      </ClientAccount>
    </SitePage>
  );
}
