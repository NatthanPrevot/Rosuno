// Home (the owner's UI/UX design: hero search, available now, two ways to
// consult, how it works, browse by legal issue, attorney invitation).
//
// Rendered on the server for every request. Session state is read only
// through the trusted server session source; the lists are the database's
// own public directory answer for the visitor's chosen jurisdiction, in its
// own neutral order. Nothing here ranks, recommends or stores anything.
// Policy answers (FAQ), status claims and legal statements are not rendered
// until approved content exists (MVP-001 Packet rule 11).
//
// DEV-001 website and appearance studio: the published appearance (read once
// per request through the application layer, validated against the
// presentation registry) may replace the registry's non-regulated text slots
// and order or hide the hideable sections; with nothing published, every
// slot renders the design's own text and the sections keep the design's
// order. The hero comes first and the available-now and legal-issue sections
// are always rendered, whatever a stored configuration says. Process and
// legal statements, status names, the neutral-order statement and the search
// form are never slots. In the studio's preview mode (rz-preview=1) the
// page renders the editor's saved draft instead, only for a holder of
// manage_site_appearance (decided by the use case and the database).

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolvePageAppearance } from "../src/application/appearance.ts";
import {
  sectionOrderOf,
  type ValidAppearance,
} from "../src/application/appearance-schema.ts";
import {
  discoveryQueryOf,
  resolveDirectory,
  selectionPath,
  type DirectoryView,
  type FilterOption,
} from "../src/application/discovery.ts";
import { getShellView } from "../src/application/shell.ts";
import { APPEARANCE_SOURCES } from "../src/infrastructure/appearance/appearance-adapter.ts";
import { DISCOVERY_SOURCES } from "../src/infrastructure/discovery/discovery-adapter.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../src/infrastructure/identity/server-session-source.ts";
import {
  HOME_SECTIONS,
  validateWithRegistry,
} from "../src/presentation/appearance/registry.ts";
import { SlotText } from "../src/presentation/appearance/slot.tsx";
import { AttorneyCard } from "../src/presentation/attorney-card.tsx";
import { SitePage } from "../src/presentation/site-chrome.tsx";
import { HomeFinder } from "./home-finder.tsx";
import { signOut } from "./sign-in/actions.ts";

export const metadata: Metadata = {
  title: "Rosuno",
};

type QueryValue = string | string[] | undefined;
type Appearance = ValidAppearance | null;

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

function AvailableNow({
  directory,
  appearance,
}: {
  readonly directory: DirectoryView;
  readonly appearance: Appearance;
}) {
  const ready = directory.status === "ready" ? directory : null;
  const jurisdictionId = ready?.query.jurisdictionId ?? null;
  const jurisdiction =
    ready?.jurisdictions.find((option) => option.id === jurisdictionId) ?? null;
  const entries = ready?.results?.entries ?? [];
  return (
    <section
      className="l-posrelative-z1-mt72-p96-0-88-bgpaper"
      data-rz="home.available"
      data-rz-section="home.available"
      id="available"
    >
      <div className="wrap">
        <div className="row between l-aiflex-end-g48">
          <div className="stack l-mw620">
            <span className="kicker l-clive-ink">
              <span className="dot" />
              Available now
            </span>
            <h2 className="h2 l-mt14" data-rz="home.available.title">
              Talk to an attorney right now
            </h2>
            <p className="body l-mt12">
              These attorneys can take a consultation request at this moment.
              You’ll see the full price before you send anything.
            </p>
          </div>
          <a
            className="link sm l-mb4"
            data-rz="home.available.browse"
            data-rz-slot="home.available.browse"
            href={directoryHref(jurisdictionId, null)}
          >
            <SlotText appearance={appearance} id="home.available.browse" />
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
                data-rz="home.available.browse"
                data-rz-slot="home.available.browse"
                href={directoryHref(jurisdictionId, null)}
              >
                <SlotText appearance={appearance} id="home.available.browse" />
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

function TwoWays({ appearance }: { readonly appearance: Appearance }) {
  return (
    <section
      className="l-p120-0"
      data-rz="home.ways"
      data-rz-section="home.ways"
      id="schedule"
    >
      <div className="wrap">
        <div className="stack l-aicenter-tacenter">
          <span
            className="kicker"
            data-rz="home.ways.kicker"
            data-rz-slot="home.ways.kicker"
          >
            <SlotText appearance={appearance} id="home.ways.kicker" />
          </span>
          <h2
            className="h2 l-mt14"
            data-rz="home.ways.title"
            data-rz-slot="home.ways.title"
          >
            <SlotText appearance={appearance} id="home.ways.title" />
          </h2>
        </div>
        <div className="l-dgrid-cols1fr-1fr-g20-mt48">
          <article
            className="well stack l-p36-36-0-ovhidden rz-way"
            data-rz="home.ways.card"
          >
            <span className="kicker l-clive-ink">
              <span className="dot" />
              Talk now
            </span>
            <h3
              className="h3 l-mt12"
              data-rz="home.ways.now.title"
              data-rz-slot="home.ways.now.title"
            >
              <SlotText appearance={appearance} id="home.ways.now.title" />
            </h3>
            <p className="body l-m8-0-14-mw460">
              Send a request to an attorney who’s available now. Once they
              accept, you meet right in your browser.
            </p>
            <a
              className="link sm"
              data-rz="home.ways.now.link"
              data-rz-slot="home.ways.now.link"
              href="#available"
            >
              <SlotText appearance={appearance} id="home.ways.now.link" />
              <ArrowIcon />
            </a>
          </article>
          <article
            className="well stack l-p36-36-0-ovhidden rz-way"
            data-rz="home.ways.card"
          >
            <span className="kicker">Schedule</span>
            <h3
              className="h3 l-mt12"
              data-rz="home.ways.schedule.title"
              data-rz-slot="home.ways.schedule.title"
            >
              <SlotText appearance={appearance} id="home.ways.schedule.title" />
            </h3>
            <p className="body l-m8-0-14-mw460">
              Pick an open time on an attorney’s calendar. It’s held for you
              while they review your request.
            </p>
            <a
              className="link sm"
              data-rz="home.ways.schedule.link"
              data-rz-slot="home.ways.schedule.link"
              href="/find-an-attorney"
            >
              <SlotText appearance={appearance} id="home.ways.schedule.link" />
              <ArrowIcon />
            </a>
          </article>
        </div>
      </div>
    </section>
  );
}

function HowItWorks({ appearance }: { readonly appearance: Appearance }) {
  return (
    <section
      className="l-p112-0-104-bgpaper"
      data-rz="home.how"
      data-rz-section="home.how"
      id="how"
    >
      <div className="wrap">
        <div className="row between l-aiflex-end-g48">
          <div className="stack">
            <span
              className="kicker"
              data-rz="home.how.kicker"
              data-rz-slot="home.how.kicker"
            >
              <SlotText appearance={appearance} id="home.how.kicker" />
            </span>
            <h2
              className="h2 l-mt14"
              data-rz="home.how.title"
              data-rz-slot="home.how.title"
            >
              <SlotText appearance={appearance} id="home.how.title" />
            </h2>
          </div>
          <div className="stack l-aiflex-end-g10">
            <p className="body l-mw360-taright">
              Four simple steps. Nothing is confirmed until the attorney
              accepts.
            </p>
          </div>
        </div>
        <ol
          className="l-dgrid-colsrp4-mm0-1fr-g24-mt52"
          data-rz="home.how.steps"
        >
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

function BrowseByIssue({
  directory,
  appearance,
}: {
  readonly directory: DirectoryView;
  readonly appearance: Appearance;
}) {
  const ready = directory.status === "ready" ? directory : null;
  const areas: readonly FilterOption[] = ready?.practiceAreas ?? [];
  const jurisdictionId = ready?.query.jurisdictionId ?? null;
  return (
    <section
      className="l-p120-0-104"
      data-rz="home.issues"
      data-rz-section="home.issues"
      id="legal-issues"
    >
      <div className="wrap">
        <div className="row between l-aiflex-end-g48">
          <div className="stack">
            <span
              className="kicker"
              data-rz="home.issues.kicker"
              data-rz-slot="home.issues.kicker"
            >
              <SlotText appearance={appearance} id="home.issues.kicker" />
            </span>
            <h2
              className="h2 l-mt14"
              data-rz="home.issues.title"
              data-rz-slot="home.issues.title"
            >
              <SlotText appearance={appearance} id="home.issues.title" />
            </h2>
          </div>
          <p
            className="body l-mw400-taright"
            data-rz="home.issues.lead"
            data-rz-slot="home.issues.lead"
          >
            <SlotText appearance={appearance} id="home.issues.lead" />
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
          <div className="rz-issues l-mt44" data-rz="home.issues.grid">
            {areas.map((area) => (
              <a
                className="xtab rz-issue"
                data-rz="home.issues.tile"
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

function AttorneyInvitation({
  appearance,
}: {
  readonly appearance: Appearance;
}) {
  return (
    <section
      className="l-p0-0-88"
      data-rz="home.attorneys"
      data-rz-section="home.attorneys"
      id="attorneys"
    >
      <div className="wrap">
        <div
          className="well row l-g20-p26-28-26-26"
          data-rz="home.attorneys.card"
        >
          <span className="stack l-f1-g2">
            <span
              className="h4 l-fs17"
              data-rz="home.attorneys.title"
              data-rz-slot="home.attorneys.title"
            >
              <SlotText appearance={appearance} id="home.attorneys.title" />
            </span>
            <span
              className="sm muted"
              data-rz="home.attorneys.body"
              data-rz-slot="home.attorneys.body"
            >
              <SlotText appearance={appearance} id="home.attorneys.body" />
            </span>
          </span>
          <a
            className="link sm l-mr10"
            data-rz="home.attorneys.apply"
            data-rz-slot="home.attorneys.apply"
            href="/attorney/apply"
          >
            <SlotText appearance={appearance} id="home.attorneys.apply" />
          </a>
          <a
            className="btn btn-line"
            data-rz="home.attorneys.explore"
            data-rz-slot="home.attorneys.explore"
            href="/for-attorneys"
          >
            <SlotText appearance={appearance} id="home.attorneys.explore" />
          </a>
        </div>
      </div>
    </section>
  );
}

function HomeHero({
  directory,
  appearance,
}: {
  readonly directory: DirectoryView;
  readonly appearance: Appearance;
}) {
  const ready = directory.status === "ready" ? directory : null;
  return (
    <section
      className="l-posrelative-z30-pt32"
      data-rz="home.hero"
      data-rz-section="home.hero"
    >
      <div className="wrap">
        <div className="l-dgrid-colsmm0-1fr-540-g72-aicenter">
          <div className="stack">
            <h1
              className="display"
              data-rz="home.hero.title"
              data-rz-slot="home.hero.title"
            >
              <SlotText appearance={appearance} id="home.hero.title" />
            </h1>
            <p
              className="lead l-mt22-mw520"
              data-rz="home.hero.lead"
              data-rz-slot="home.hero.lead"
            >
              <SlotText appearance={appearance} id="home.hero.lead" />
            </p>
            <HomeFinder
              practiceAreas={ready?.practiceAreas ?? []}
              jurisdictions={ready?.jurisdictions ?? []}
            />
          </div>
          <figure
            className="l-posrelative-h580-rcalcr-1_6-ovhidd-b518bf rz-hero-figure"
            data-rz="home.hero.figure"
          >
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
  );
}

export default async function HomePage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly jurisdiction?: QueryValue;
    readonly "rz-preview"?: QueryValue;
  }>;
}) {
  // Session state belongs to each request on the server; never prerender it.
  await connection();
  const view = await getShellView(SUPABASE_SERVER_SESSION_SOURCE);
  const { jurisdiction, "rz-preview": previewValue } = await searchParams;
  const directory = await homeDirectory(jurisdiction);
  // The published appearance; in the studio's preview mode (exactly
  // rz-preview=1) a holder of manage_site_appearance sees the saved draft
  // (the use case decides; anyone else still sees the published version).
  const { configuration } = await resolvePageAppearance(
    APPEARANCE_SOURCES,
    validateWithRegistry,
    previewValue === "1",
  );
  const sections: Readonly<Record<string, ReactNode>> = {
    "home.hero": (
      <HomeHero
        key="home.hero"
        directory={directory}
        appearance={configuration}
      />
    ),
    "home.available": (
      <AvailableNow
        key="home.available"
        directory={directory}
        appearance={configuration}
      />
    ),
    "home.ways": <TwoWays key="home.ways" appearance={configuration} />,
    "home.how": <HowItWorks key="home.how" appearance={configuration} />,
    "home.issues": (
      <BrowseByIssue
        key="home.issues"
        directory={directory}
        appearance={configuration}
      />
    ),
    "home.attorneys": (
      <AttorneyInvitation key="home.attorneys" appearance={configuration} />
    ),
  };
  return (
    <SitePage session={view.session} signOut={signOut}>
      {sectionOrderOf(configuration, HOME_SECTIONS).map((id) => sections[id])}
    </SitePage>
  );
}
