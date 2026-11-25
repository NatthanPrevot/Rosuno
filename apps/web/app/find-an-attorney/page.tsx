// Find an attorney: the public directory (MVP-001 S5; MBS sections 10 and
// 18.1; TA sections 28, 29 and 55), in the owner's UI/UX design (Browse:
// breadcrumbs, filter bar, results header, card grid).
//
// Rendered on the server for every request; the same list for every
// visitor, signed in or not. The only request values read are the four
// filter query values (jurisdiction, practice area, availability, page),
// which the discovery use case checks on the server. The list is the
// database's own derived answer, in its own neutral order (by name): nothing
// here ranks, recommends or reorders, and a directory render persists
// nothing. Only the allowlisted public fields are shown. Each listed
// attorney links to the public profile and to the selection page, where the
// client chooses.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  discoveryQueryOf,
  resolveDirectory,
  selectionPath,
} from "../../src/application/discovery.ts";
import { getShellView } from "../../src/application/shell.ts";
import { DISCOVERY_SOURCES } from "../../src/infrastructure/discovery/discovery-adapter.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../src/infrastructure/identity/server-session-source.ts";
import { logRequestEvent } from "../../src/infrastructure/observability/request-log.ts";
import { AttorneyCard } from "../../src/presentation/attorney-card.tsx";
import { Alert } from "../../src/presentation/design-system.tsx";
import {
  AVAILABILITY_LABELS,
  CHOOSE_PROMPT,
  DIRECTORY_NOTE,
  INVALID_PROMPT,
  NO_JURISDICTIONS,
  NO_RESULTS,
  ORDER_LABEL,
} from "../../src/presentation/discovery-labels.ts";
import { SitePage } from "../../src/presentation/site-chrome.tsx";
import { signOut } from "../sign-in/actions.ts";

export const metadata: Metadata = {
  title: "Find an attorney",
};

type QueryValue = string | string[] | undefined;

function directoryHref(
  jurisdictionId: string,
  practiceAreaId: string | null,
  availability: string,
  page: number,
): string {
  return `/find-an-attorney?${[
    `jurisdiction=${jurisdictionId}`,
    ...(practiceAreaId === null ? [] : [`practice_area=${practiceAreaId}`]),
    `availability=${availability}`,
    `page=${page}`,
  ].join("&")}`;
}

function Breadcrumbs() {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <a href="/">Home</a>
      <span aria-hidden="true">/</span>
      <span className="l-cink" aria-current="page">
        Find an attorney
      </span>
    </nav>
  );
}

function Heading() {
  return (
    <div className="row between l-mt14-aiflex-end-g32">
      <div className="stack l-g8">
        <h1 className="h2 l-fs40" id="directory-title">
          Find an attorney
        </h1>
        <p className="sm muted">{DIRECTORY_NOTE}</p>
      </div>
      <a className="link sm" href="/client/requests/new">
        Help me find an attorney
      </a>
    </div>
  );
}

export default async function FindAnAttorneyPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly jurisdiction?: QueryValue;
    readonly practice_area?: QueryValue;
    readonly availability?: QueryValue;
    readonly page?: QueryValue;
  }>;
}) {
  // Derived on every request on the server; never prerendered or cached.
  await connection();
  const query = discoveryQueryOf(await searchParams);
  const view = await resolveDirectory(DISCOVERY_SOURCES, query);
  const shell = await getShellView(SUPABASE_SERVER_SESSION_SOURCE);
  if (view.status !== "ready") {
    await logRequestEvent("warn", "discovery.view_unavailable", {
      route: "/find-an-attorney",
      outcome: view.status,
    });
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <section className="wrap pg l-pt28 rz-section-end">
          <Breadcrumbs />
          <Heading />
          <div className="l-mt24">
            <Alert tone="error" title="Something went wrong" role="alert">
              The directory could not be shown right now. Please try again
              later.
            </Alert>
          </div>
        </section>
      </SitePage>
    );
  }
  const results = view.results;
  const jurisdiction =
    view.jurisdictions.find((option) => option.id === query.jurisdictionId) ??
    null;
  const area =
    view.practiceAreas.find((option) => option.id === query.practiceAreaId) ??
    null;
  return (
    <SitePage session={shell.session} signOut={signOut}>
      <section className="wrap pg l-pt28 rz-section-end">
        <Breadcrumbs />
        <Heading />
        {view.jurisdictions.length === 0 ? (
          <p className="body l-mt24">{NO_JURISDICTIONS}</p>
        ) : (
          <form action="/find-an-attorney" method="get">
            <div className="fbar l-mt24-posrelative-z20 rz-fbar">
              <select
                className="selx rz-fsel"
                name="jurisdiction"
                aria-label="State"
                required
                defaultValue={query.jurisdictionId ?? ""}
              >
                <option value="">Choose a state</option>
                {view.jurisdictions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
              <select
                className="selx rz-fsel"
                name="practice_area"
                aria-label="Legal issue"
                defaultValue={query.practiceAreaId ?? ""}
              >
                <option value="">Any legal issue</option>
                {view.practiceAreas.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
              <select
                className="selx rz-fsel"
                name="availability"
                aria-label="Availability"
                defaultValue={query.availability}
              >
                <option value="any">{AVAILABILITY_LABELS.any}</option>
                <option value="instant">{AVAILABILITY_LABELS.instant}</option>
                <option value="scheduled">
                  {AVAILABILITY_LABELS.scheduled}
                </option>
              </select>
              <button className="btn btn-ink btn-sm" type="submit">
                Search
              </button>
            </div>
          </form>
        )}
        {view.prompt === "choose" && view.jurisdictions.length > 0 ? (
          <div className="panel stack l-mt18-p48-aicenter-tacenter">
            <p className="h3 l-fs22-mt16">Choose a state</p>
            <p className="body l-mt6-mw520">{CHOOSE_PROMPT}</p>
          </div>
        ) : null}
        {view.prompt === "invalid" ? (
          <div className="l-mt22-g24">
            <Alert tone="warning" title="Check the filters">
              {INVALID_PROMPT}
            </Alert>
          </div>
        ) : null}
        {results === null || jurisdiction === null ? null : (
          <>
            <div className="row between l-mt22-g24">
              <div className="row l-g10-fwrwrap">
                <span className="sm l-fw600">
                  {results.entries.length === 1
                    ? "1 attorney on this page"
                    : `${results.entries.length} attorneys on this page`}
                </span>
                <span className="tok l-h28-fs12_5">
                  <span>{jurisdiction.name}</span>
                </span>
                {area === null ? null : (
                  <span className="tok l-h28-fs12_5">
                    <span>{area.name}</span>
                  </span>
                )}
                {query.availability === "any" ? null : (
                  <span className="tok l-h28-fs12_5">
                    <span>{AVAILABILITY_LABELS[query.availability]}</span>
                  </span>
                )}
              </div>
              <span className="xs subtle">{ORDER_LABEL}</span>
            </div>
            {results.entries.length === 0 ? (
              <div className="panel stack l-mt18-p48-aicenter-tacenter">
                <p className="h3 l-fs22-mt16">{NO_RESULTS}</p>
                <p className="body l-mt6-mw520">
                  Try removing a filter, or tell us a little more and narrow
                  things down.
                </p>
                <div className="row l-g8-mt20">
                  <a
                    className="btn btn-ink"
                    href={directoryHref(jurisdiction.id, null, "any", 1)}
                  >
                    Clear filters
                  </a>
                  <a className="btn btn-line" href="/client/requests/new">
                    Help me find an attorney
                  </a>
                </div>
              </div>
            ) : (
              <div className="grid3 l-mt18">
                {results.entries.map((entry) => (
                  <AttorneyCard
                    key={entry.attorneyId}
                    entry={entry}
                    jurisdictionName={jurisdiction.name}
                    profileHref={`/attorneys/${entry.attorneyId}?jurisdiction=${jurisdiction.id}`}
                    talkNowHref={
                      entry.availableNow && query.availability !== "scheduled"
                        ? selectionPath({
                            attorneyId: entry.attorneyId,
                            jurisdictionId: jurisdiction.id,
                            practiceAreaId: query.practiceAreaId,
                            availability: "instant",
                            page: results.page,
                          })
                        : null
                    }
                    scheduleHref={
                      entry.scheduledAvailability &&
                      query.availability !== "instant"
                        ? selectionPath({
                            attorneyId: entry.attorneyId,
                            jurisdictionId: jurisdiction.id,
                            practiceAreaId: query.practiceAreaId,
                            availability: "scheduled",
                            page: results.page,
                          })
                        : null
                    }
                  />
                ))}
              </div>
            )}
            {results.previousPage === null &&
            results.nextPage === null ? null : (
              <nav className="row l-mt22-g24 rz-pager" aria-label="Pages">
                {results.previousPage === null ? null : (
                  <a
                    className="btn btn-line btn-sm"
                    href={directoryHref(
                      jurisdiction.id,
                      query.practiceAreaId,
                      query.availability,
                      results.previousPage,
                    )}
                  >
                    Previous page
                  </a>
                )}
                {results.nextPage === null ? null : (
                  <a
                    className="btn btn-line btn-sm"
                    href={directoryHref(
                      jurisdiction.id,
                      query.practiceAreaId,
                      query.availability,
                      results.nextPage,
                    )}
                  >
                    Next page
                  </a>
                )}
              </nav>
            )}
          </>
        )}
      </section>
    </SitePage>
  );
}
