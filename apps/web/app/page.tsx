// Home (the owner's UI/UX design: hero search, available now, two ways to
// consult, how it works, browse by legal issue, attorney invitation).
//
// Rendered on the server for every request. Session state is read only
// through the trusted server session source; the lists are the database's
// own public directory answer for the visitor's chosen jurisdiction, in its
// own neutral order. Nothing here ranks, recommends or stores anything.
// Policy answers (FAQ), status claims and legal statements are not rendered
// until approved content exists (MVP-001 Packet rule 11).

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  discoveryQueryOf,
  resolveDirectory,
  selectionPath,
  type DirectoryView,
  type FilterOption,
} from "../src/application/discovery.ts";
import { getShellView } from "../src/application/shell.ts";
import { DISCOVERY_SOURCES } from "../src/infrastructure/discovery/discovery-adapter.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../src/infrastructure/identity/server-session-source.ts";
import { AttorneyCard } from "../src/presentation/attorney-card.tsx";
import { SitePage } from "../src/presentation/site-chrome.tsx";
import { HomeFinder } from "./home-finder.tsx";
import { signOut } from "./sign-in/actions.ts";

export const metadata: Metadata = {
  title: "Rosuno",
};

type QueryValue = string | string[] | undefined;

const STEPS = Object.freeze([
  {
    title: "Describe your issue",
    detail: "A few words is enough — or pick a legal issue.",
  },
  {
    title: "Choose an attorney",
    detail: "Compare practice areas, prices and availability.",
  },
  {
    title: "Request a consultation",
    detail: "It’s confirmed only once the attorney accepts.",
  },
  {
    title: "Meet by video or audio",
    detail: "Right in your browser — nothing to install.",
  },
]);

function ArrowIcon() {
  return (
    <svg
      className="go"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function directoryHref(
  jurisdictionId: string | null,
  practiceAreaId: string | null,
): string {
  if (jurisdictionId === null) {
    return "/find-an-attorney";
  }
  return `/find-an-attorney?${[
    `jurisdiction=${jurisdictionId}`,
    ...(practiceAreaId === null ? [] : [`practice_area=${practiceAreaId}`]),
  ].join("&")}`;
}

// The visitor's jurisdiction, or the only listed one.
async function homeDirectory(jurisdiction: QueryValue): Promise<DirectoryView> {
  const first = await resolveDirectory(
    DISCOVERY_SOURCES,
    discoveryQueryOf({ jurisdiction, availability: "instant" }),
  );
  if (
    first.status === "ready" &&
    first.query.jurisdictionId === null &&
    first.jurisdictions.length === 1
  ) {
    return resolveDirectory(
      DISCOVERY_SOURCES,
      discoveryQueryOf({
        jurisdiction: first.jurisdictions[0].id,
        availability: "instant",
      }),
    );
  }
  return first;
}

function AvailableNow({ directory }: { readonly directory: DirectoryView }) {
  const ready = directory.status === "ready" ? directory : null;
  const jurisdictionId = ready?.query.jurisdictionId ?? null;
  const jurisdiction =
    ready?.jurisdictions.find((option) => option.id === jurisdictionId) ?? null;
  const entries = ready?.results?.entries ?? [];
  return (
    <section className="l-posrelative-z1-mt72-p96-0-88-bgpaper" id="available">
      <div className="wrap">
        <div className="row between l-aiflex-end-g48">
          <div className="stack l-mw620">
            <span className="kicker l-clive-ink">
              <span className="dot" />
              Available now
            </span>
            <h2 className="h2 l-mt14">Talk to an attorney right now</h2>
            <p className="body l-mt12">
              These attorneys can take a consultation request at this moment.
              You’ll see the full price before you send anything.
            </p>
          </div>
          <a
            className="link sm l-mb4"
            href={directoryHref(jurisdictionId, null)}
          >
            Browse all attorneys
            <ArrowIcon />
          </a>
        </div>
        {ready !== null && ready.jurisdictions.length > 1 ? (
          <nav className="row l-mt32-g24 rz-chips" aria-label="State">
            {ready.jurisdictions.map((option) => (
              <a
                className={
                  option.id === jurisdictionId ? "opt-chip on" : "opt-chip"
                }
                aria-current={option.id === jurisdictionId ? "true" : undefined}
                key={option.id}
                href={`/?jurisdiction=${option.id}#available`}
              >
                {option.name}
              </a>
            ))}
          </nav>
        ) : null}
        {jurisdiction !== null && entries.length > 0 ? (
          <div
            className="car l-mt20"
            aria-label="Attorneys available now"
            role="region"
          >
            {entries.map((entry) => (
              <AttorneyCard
                key={entry.attorneyId}
                entry={entry}
                jurisdictionName={jurisdiction.name}
                profileHref={`/attorneys/${entry.attorneyId}?jurisdiction=${jurisdiction.id}`}
                talkNowHref={selectionPath({
                  attorneyId: entry.attorneyId,
                  jurisdictionId: jurisdiction.id,
                  practiceAreaId: null,
                  availability: "instant",
                  page: 1,
                })}
                scheduleHref={
                  entry.scheduledAvailability
                    ? selectionPath({
                        attorneyId: entry.attorneyId,
                        jurisdictionId: jurisdiction.id,
                        practiceAreaId: null,
                        availability: "scheduled",
                        page: 1,
                      })
                    : null
                }
              />
            ))}
          </div>
        ) : (
          <div className="panel row l-mt20-p36-40-g40-jcspace-between">
            <div className="stack l-g6-mw620">
              <p className="h3 l-fs22">
                {ready === null
                  ? "Attorney listings aren’t available right now"
                  : ready.jurisdictions.length === 0
                    ? "No states are listed yet"
                    : jurisdiction === null
                      ? "Choose the state connected to your matter"
                      : "No one is available right now"}
              </p>
              <p className="body">
                Attorneys turn on Talk Now when they’re ready to take requests.
                You can schedule a consultation at an open time instead.
              </p>
            </div>
            <div className="row l-g8">
              <a
                className="btn btn-line"
                href={directoryHref(jurisdictionId, null)}
              >
                Browse all attorneys
              </a>
            </div>
          </div>
        )}
        <div className="row between l-mt22-g24">
          <span className="xs subtle">
            Listed in no particular order — not ranked or recommended.{" "}
            <span className="ph">
              [Order of presentation and any presentation record — pending
              legal/technical decision]
            </span>
          </span>
        </div>
      </div>
    </section>
  );
}

function TwoWays() {
  return (
    <section className="l-p120-0" id="schedule">
      <div className="wrap">
        <div className="stack l-aicenter-tacenter">
          <span className="kicker">Two ways to consult</span>
          <h2 className="h2 l-mt14">Talk now, or at a time that suits you.</h2>
        </div>
        <div className="l-dgrid-cols1fr-1fr-g20-mt48">
          <article className="well stack l-p36-36-0-ovhidden rz-way">
            <span className="kicker l-clive-ink">
              <span className="dot" />
              Talk now
            </span>
            <h3 className="h3 l-mt12">When you’d like answers today</h3>
            <p className="body l-m8-0-14-mw460">
              Send a request to an attorney who’s available now. Once they
              accept, you meet right in your browser.
            </p>
            <a className="link sm" href="#available">
              See who’s available
              <ArrowIcon />
            </a>
          </article>
          <article className="well stack l-p36-36-0-ovhidden rz-way">
            <span className="kicker">Schedule</span>
            <h3 className="h3 l-mt12">When you’d rather plan ahead</h3>
            <p className="body l-m8-0-14-mw460">
              Pick an open time on an attorney’s calendar. It’s held for you
              while they review your request.
            </p>
            <a className="link sm" href="/find-an-attorney">
              Browse open times
              <ArrowIcon />
            </a>
          </article>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="l-p112-0-104-bgpaper" id="how">
      <div className="wrap">
        <div className="row between l-aiflex-end-g48">
          <div className="stack">
            <span className="kicker">How Rosuno works</span>
            <h2 className="h2 l-mt14">From a question to a conversation.</h2>
          </div>
          <div className="stack l-aiflex-end-g10">
            <p className="body l-mw360-taright">
              Four simple steps. Nothing is confirmed until the attorney
              accepts.
            </p>
          </div>
        </div>
        <ol className="l-dgrid-colsrp4-mm0-1fr-g24-mt52">
          {STEPS.map((step, index) => (
            <li className="stack" key={step.title}>
              <div className="row l-g12-mt24">
                <span className="num l-fnone-w28-h28-r50pc-dgrid-picenter-7eb0e7">
                  {index + 1}
                </span>
                <span
                  className={
                    index === STEPS.length - 1
                      ? "rz-step-line rz-step-line--last"
                      : "rz-step-line"
                  }
                />
              </div>
              <p className="h4 l-mt16">{step.title}</p>
              <p className="sm muted l-mt4-mw260">{step.detail}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function BrowseByIssue({ directory }: { readonly directory: DirectoryView }) {
  const ready = directory.status === "ready" ? directory : null;
  const areas: readonly FilterOption[] = ready?.practiceAreas ?? [];
  const jurisdictionId = ready?.query.jurisdictionId ?? null;
  return (
    <section className="l-p120-0-104" id="legal-issues">
      <div className="wrap">
        <div className="row between l-aiflex-end-g48">
          <div className="stack">
            <span className="kicker">Browse by legal issue</span>
            <h2 className="h2 l-mt14">Not sure what to search for?</h2>
          </div>
          <p className="body l-mw400-taright">
            Pick the area that sounds closest and start from a familiar
            situation.
          </p>
        </div>
        {areas.length === 0 ? (
          <div className="panel stack l-p32-32-28 l-mt44 rz-issues-empty">
            <p className="h3">No legal issues are listed yet.</p>
            <a className="link sm" href="/client/requests/new">
              Help me find an attorney
            </a>
          </div>
        ) : (
          <div className="rz-issues l-mt44">
            {areas.map((area) => (
              <a
                className="xtab rz-issue"
                key={area.id}
                href={directoryHref(jurisdictionId, area.id)}
              >
                <span className="stack l-g1-minw0">
                  <span className="l-fff-display-fs16-fw600-ls0_012em">
                    {area.name}
                  </span>
                  <span className="xs subtle">See attorneys</span>
                </span>
              </a>
            ))}
          </div>
        )}
        <p className="xs subtle l-mt14">
          Examples only — choosing an area isn’t legal advice or a legal
          classification.
        </p>
      </div>
    </section>
  );
}

function AttorneyInvitation() {
  return (
    <section className="l-p0-0-88" id="attorneys">
      <div className="wrap">
        <div className="well row l-g20-p26-28-26-26">
          <span className="stack l-f1-g2">
            <span className="h4 l-fs17">Are you an attorney?</span>
            <span className="sm muted">
              Manage consultations, availability and requests with Rosuno.
            </span>
          </span>
          <a className="link sm l-mr10" href="/attorney/apply">
            Apply to join
          </a>
          <a className="btn btn-line" href="/for-attorneys">
            Explore Rosuno for attorneys
          </a>
        </div>
      </div>
    </section>
  );
}

export default async function HomePage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly jurisdiction?: QueryValue }>;
}) {
  // Session state belongs to each request on the server; never prerender it.
  await connection();
  const view = await getShellView(SUPABASE_SERVER_SESSION_SOURCE);
  const { jurisdiction } = await searchParams;
  const directory = await homeDirectory(jurisdiction);
  const ready = directory.status === "ready" ? directory : null;
  return (
    <SitePage session={view.session} signOut={signOut}>
      <section className="l-posrelative-z30-pt32">
        <div className="wrap">
          <div className="l-dgrid-colsmm0-1fr-540-g72-aicenter">
            <div className="stack">
              <h1 className="display">
                Talk to a lawyer
                <br />
                in minutes.
              </h1>
              <p className="lead l-mt22-mw520">
                Describe what’s going on in plain words. Meet an attorney now,
                or book a time that suits you.
              </p>
              <HomeFinder
                practiceAreas={ready?.practiceAreas ?? []}
                jurisdictions={ready?.jurisdictions ?? []}
              />
            </div>
            <figure className="l-posrelative-h580-rcalcr-1_6-ovhidd-b518bf rz-hero-figure">
              <span className="status l-l16-bo16-h32-p0-12-fs13-fw500-cink-2">
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="3" y="6" width="13" height="12" rx="2.5" />
                  <path d="m16 10 5-3v10l-5-3" />
                </svg>
                Video or audio, right in your browser
              </span>
            </figure>
          </div>
        </div>
      </section>
      <AvailableNow directory={directory} />
      <TwoWays />
      <HowItWorks />
      <BrowseByIssue directory={directory} />
      <AttorneyInvitation />
    </SitePage>
  );
}
