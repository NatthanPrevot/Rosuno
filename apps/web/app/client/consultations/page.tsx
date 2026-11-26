// The client's Consultations (MVP-001 S11; MBS section 18 "client
// surfaces"; DM section 2.4; DEV-001: the owner's UI/UX design, the client
// account's My consultations).
//
// Rendered on the server for every request and never indexed. The verified
// client of the request decides access (the client intake sources); the
// database answers only the client's own Consultations. They are grouped as
// the server reports them into the design's Upcoming view (current ones,
// ready as soon as the server reports the window open or in progress, then
// upcoming ones) and its Past view (ended ones with how they ended, and
// cancelled ones). The one query value read, show, only chooses the view:
// exactly "past" shows the Past view and anything else the Upcoming view.
// Each Consultation links to its own page, where the database decides every
// action again.
//
// DEV-001: the owner's UI/UX design's Pending view and the names on the
// list. Exactly "pending" as the show value shows the client's own open
// Requests (the client_requests read, through the participant workspace
// sources, which re-verify the client), 25 a page: the page value only names
// the page and is read in the Pending view only. Each Request shows the
// attorney's presentable name, the path, the time asked for and the response
// deadline (UTC) and links to its request page; one the server reports past
// its deadline is shown expired, as the request page shows it. The Pending
// count is that of the first page (25 and more when another page follows).
// Each Consultation shows the attorney's presentable name and the client's
// own practice area answer (client_consultation_parties), joined by
// Consultation id; when that read is unavailable the list is shown without
// them, as before. Nothing of the attorney's contact details is shown.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  clientDisplayStateOf,
  resolveClientConsultationParties,
  resolveClientConsultations,
  type ClientConsultationEntry,
  type ConsultationParty,
} from "../../../src/application/consultation-outcomes.ts";
import { resolveClientRequests } from "../../../src/application/participant-workspaces.ts";
import { getShellView } from "../../../src/application/shell.ts";
import { CLIENT_OUTCOME_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../src/infrastructure/identity/server-session-source.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { CLIENT_WORKSPACE_SOURCES } from "../../../src/infrastructure/workspaces/workspace-adapter.ts";
import {
  ClientAccount,
  ClientGate,
  ClientPill,
  ConsultationTile,
  ModalityIcon,
  RequestRows,
  RowChevron,
  TIMES_IN_UTC,
  whenText,
} from "../../../src/presentation/client-account.tsx";
import {
  CLIENT_GROUPS,
  outcomeLabelOf,
} from "../../../src/presentation/completion-labels.ts";
import {
  CLIENT_STATE_LABELS,
  durationText,
  modalityText,
  PATH_LABELS,
} from "../../../src/presentation/consultation-labels.ts";
import { Alert } from "../../../src/presentation/design-system.tsx";
import { SitePage } from "../../../src/presentation/site-chrome.tsx";
import { signOut } from "../../sign-in/actions.ts";

export const metadata: Metadata = {
  title: "Your consultations",
  robots: { index: false, follow: false },
};

type Group = (typeof CLIENT_GROUPS)[number]["key"];

function groupOf(entry: ClientConsultationEntry): Group {
  const shown = clientDisplayStateOf(entry);
  if (shown === "live" || shown === "ready") {
    return "active";
  }
  if (shown === "created" || shown === "scheduled") {
    return "upcoming";
  }
  return shown === "cancelled" ? "cancelled" : "ended";
}

// The design's two views: Upcoming (now, then upcoming) and Past (ended,
// then cancelled), each in the server's own order within a group.
const VIEWS = Object.freeze({
  upcoming: ["active", "upcoming"],
  past: ["ended", "cancelled"],
} as const satisfies Record<string, readonly Group[]>);

function whenOf(entry: ClientConsultationEntry): string {
  if (entry.bookingStart !== null) {
    return whenText(entry.bookingStart);
  }
  return entry.startedAt === null
    ? PATH_LABELS[entry.path]
    : whenText(entry.startedAt);
}

// DEV-001: the owner's UI/UX design's row: the attorney's presentable name
// and the client's own practice area where the parties read answers them;
// without them, the consultation type and how it went, as before.
function ConsultationRow({
  entry,
  party,
}: {
  readonly entry: ClientConsultationEntry;
  readonly party: ConsultationParty | null;
}) {
  const state = CLIENT_STATE_LABELS[clientDisplayStateOf(entry)];
  const outcome = outcomeLabelOf(entry.outcomeCode);
  const name = party?.attorneyName ?? null;
  const matter = [
    party?.practiceArea ?? null,
    outcome ?? PATH_LABELS[entry.path],
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <div className="cx-rec">
      <a
        className="cx-rbtn2 rz-cx-row"
        href={`/client/consultations/${entry.id}`}
      >
        <ConsultationTile modality={entry.modality} />
        <span className="l-minw0">
          <span className="cx-rn l-dblock">
            {name ?? modalityText(entry.modality)}
          </span>
          <span className="cx-rm l-dblock">{matter}</span>
        </span>
        <span className="l-minw0">
          <span className="cx-rw l-dblock">{whenOf(entry)}</span>
          {name === null ? (
            entry.durationMinutes === null ? null : (
              <span className="cx-rw2 l-dblock">
                {durationText(entry.durationMinutes)}
              </span>
            )
          ) : (
            <span className="cx-rw2 cux-ty l-dflex">
              {entry.durationMinutes === null
                ? null
                : `${durationText(entry.durationMinutes)} · `}
              <ModalityIcon modality={entry.modality} />
              <span>{modalityText(entry.modality)}</span>
            </span>
          )}
        </span>
        <span className="cx-rs">
          <ClientPill tone={state.tone}>{state.label}</ClientPill>
        </span>
        <RowChevron />
      </a>
    </div>
  );
}

// DEV-001: the Pending view's own pages (the first page has the bare
// address).
function pendingHref(pageNumber: number): string {
  return pageNumber === 1
    ? "/client/consultations?show=pending"
    : `/client/consultations?show=pending&page=${pageNumber}`;
}

export default async function ClientConsultationsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly show?: string | string[];
    readonly page?: string | string[];
  }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const shell = await getShellView(SUPABASE_SERVER_SESSION_SOURCE);
  const { show, page } = await searchParams;
  const view = await resolveClientConsultations(CLIENT_OUTCOME_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="Sign in to continue">
          <p className="sm muted">
            Your consultations are available only to their signed-in client.
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
        <ClientGate heading="My consultations">
          <Alert tone="warning" title="Not available" role="status">
            This account does not have client consultations.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "consultation.list_unavailable", {
      route: "/client/consultations",
      outcome: view.status,
    });
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <ClientGate heading="My consultations">
          <Alert tone="error" title="Something went wrong" role="alert">
            Your consultations could not be shown right now. Please try again
            later.
          </Alert>
        </ClientGate>
      </SitePage>
    );
  }
  // DEV-001: the attorney's presentable name and the client's own practice
  // area for each listed Consultation, after the list read; without them the
  // list is shown as before.
  const parties = await resolveClientConsultationParties(
    CLIENT_OUTCOME_SOURCES,
  );
  if (parties.status !== "ready") {
    await logRequestEvent("warn", "consultation.list_unavailable", {
      route: "/client/consultations",
      operation: "resolveClientConsultationParties",
      outcome: parties.status,
    });
  }
  const partyOf = (entry: ClientConsultationEntry): ConsultationParty | null =>
    parties.status === "ready" ? (parties.parties.get(entry.id) ?? null) : null;
  const past = show === "past";
  // DEV-001: exactly "pending" shows the design's Pending view.
  const pending = show === "pending";
  // DEV-001: the client's own open Requests, after the existing reads: the
  // page asked for in the Pending view, the first page otherwise (for the
  // count).
  const requests = await resolveClientRequests(
    CLIENT_WORKSPACE_SOURCES,
    "open",
    pending ? page : "1",
  );
  if (requests.status !== "ready") {
    await logRequestEvent("warn", "consultation.list_unavailable", {
      route: "/client/consultations",
      operation: "resolveClientRequests",
      outcome: requests.status,
    });
  }
  const pendingCount =
    requests.status === "ready" && requests.pager.page === 1
      ? `${requests.requests.length}${requests.pager.hasNext ? "+" : ""}`
      : null;
  const pager =
    pending &&
    requests.status === "ready" &&
    (requests.pager.page > 1 || requests.pager.hasNext)
      ? requests.pager
      : null;
  const inView = (key: keyof typeof VIEWS) =>
    VIEWS[key].flatMap((group) =>
      view.entries.filter((entry) => groupOf(entry) === group),
    );
  const upcoming = inView("upcoming");
  const ended = inView("past");
  const shown = past ? ended : upcoming;
  const onUpcoming = !past && !pending;
  return (
    <SitePage session={shell.session} signOut={signOut}>
      <ClientAccount area="consultations" heading="My consultations">
        <div className="cx-tools">
          <div className="row l-g12-fwrwrap">
            <nav className="cx-seg" aria-label="Show">
              <a
                className={onUpcoming ? "on" : undefined}
                href="/client/consultations"
                aria-current={onUpcoming ? "page" : undefined}
              >
                <span>Upcoming</span>
                <span className="n">{upcoming.length}</span>
              </a>
              <a
                className={pending ? "on" : undefined}
                href="/client/consultations?show=pending"
                aria-current={pending ? "page" : undefined}
              >
                <span>Pending</span>
                {pendingCount === null ? null : (
                  <span className="n">{pendingCount}</span>
                )}
              </a>
              <a
                className={past ? "on" : undefined}
                href="/client/consultations?show=past"
                aria-current={past ? "page" : undefined}
              >
                <span>Past</span>
                <span className="n">{ended.length}</span>
              </a>
            </nav>
          </div>
          <span className="cx-note">{TIMES_IN_UTC}</span>
        </div>
        {pending ? (
          <>
            {requests.status === "ready" && requests.requests.length > 0 ? (
              <p className="cx-once l-mt14">
                Requests aren’t booked until the attorney accepts.
              </p>
            ) : null}
            <section
              className="cx-card cx-recs"
              aria-label="Requests awaiting a response"
            >
              <RequestRows view={requests} />
            </section>
            {pager === null ? null : (
              <div className="row l-g8 l-mt14">
                {pager.page > 1 ? (
                  <a
                    className="btn btn-line btn-sm"
                    href={pendingHref(pager.page - 1)}
                  >
                    Show newer requests
                  </a>
                ) : null}
                {pager.hasNext ? (
                  <a
                    className="btn btn-line btn-sm"
                    href={pendingHref(pager.page + 1)}
                  >
                    Show older requests
                  </a>
                ) : null}
              </div>
            )}
          </>
        ) : (
          <section
            className="cx-card cx-recs"
            aria-label={past ? "Past consultations" : "Upcoming consultations"}
          >
            {shown.map((entry) => (
              <ConsultationRow
                key={entry.id}
                entry={entry}
                party={partyOf(entry)}
              />
            ))}
            {shown.length === 0 ? (
              <div className="cx-emptyrow">
                <p className="h4">
                  {past ? "No past consultations" : "No upcoming consultations"}
                </p>
                <p className="sm muted l-mt4">
                  {past
                    ? "Ended and cancelled consultations appear here."
                    : "When an attorney accepts a request, it appears here."}
                </p>
                {past ? null : (
                  <a
                    className="btn btn-ink btn-sm l-mt14"
                    href="/find-an-attorney"
                  >
                    Find an attorney
                  </a>
                )}
              </div>
            ) : null}
          </section>
        )}
        <nav className="rz-cx-links" aria-label="More about your consultations">
          <a className="cx-link" href="/client/messages">
            Messages
          </a>
          <a className="cx-link" href="/client/reviews">
            Your reviews
          </a>
        </nav>
      </ClientAccount>
    </SitePage>
  );
}
