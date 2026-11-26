// The public attorney profile (MVP-001 S5 and S6 PS-A3; MBS section 10), in
// the owner's UI/UX design (the profile and its booking panel side by side).
//
// Rendered on the server for every request. The profile, the public offers
// and the open times are the database's own allowlisted answer, shown in its
// own order; the published reviews come through the public review sources
// only. The booking panel links to the selection page for each request path
// the attorney offers; nothing is requested, held or stored here.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import {
  resolveAttorneyProfile,
  selectionPath,
} from "../../../src/application/discovery.ts";
import { resolvePublicReviews } from "../../../src/application/reviews.ts";
import { getShellView } from "../../../src/application/shell.ts";
import { PUBLIC_REVIEW_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { DISCOVERY_SOURCES } from "../../../src/infrastructure/discovery/discovery-adapter.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../src/infrastructure/identity/server-session-source.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import {
  PUBLIC_REVIEWS_NOTE,
  RATING_LABELS,
} from "../../../src/presentation/completion-labels.ts";
import { Alert } from "../../../src/presentation/design-system.tsx";
import {
  AVAILABLE_NOW,
  NO_OFFERS,
  NO_WINDOWS,
  offerText,
  OFFERS_JURISDICTION_NOTE,
  OFFERS_NOTE,
  PROFILE_JURISDICTION_NOTE,
  utcText,
  WINDOWS_NOTE,
  yearsText,
} from "../../../src/presentation/discovery-labels.ts";
import { SitePage } from "../../../src/presentation/site-chrome.tsx";
import { signOut } from "../../sign-in/actions.ts";

export const metadata: Metadata = {
  title: "Attorney profile",
};

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => /^[\p{L}]/u.test(part))
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

function firstNameOf(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

export default async function AttorneyProfilePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly attorney: string }>;
  readonly searchParams: Promise<{
    readonly jurisdiction?: string | string[];
  }>;
}) {
  await connection();
  const { attorney } = await params;
  const { jurisdiction } = await searchParams;
  const view = await resolveAttorneyProfile(
    DISCOVERY_SOURCES,
    attorney,
    jurisdiction,
  );
  if (view.status === "not-found") {
    notFound();
  }
  const shell = await getShellView(SUPABASE_SERVER_SESSION_SOURCE);
  if (view.status !== "ready") {
    await logRequestEvent("warn", "discovery.view_unavailable", {
      route: "/attorneys/[attorney]",
      outcome: view.status,
    });
    return (
      <SitePage session={shell.session} signOut={signOut}>
        <section className="wrap pg l-pt28 rz-section-end">
          <h1 className="h2 l-fs40" data-rz="profile.title" id="profile-title">
            Attorney profile
          </h1>
          <div className="l-mt24">
            <Alert tone="error" title="Something went wrong" role="alert">
              This profile could not be shown right now. Please try again later.
            </Alert>
          </div>
        </section>
      </SitePage>
    );
  }
  const { profile, jurisdictionId, offers } = view;
  const years = yearsText(profile.yearsExperience);
  const reviews = await resolvePublicReviews(PUBLIC_REVIEW_SOURCES, attorney);
  const first = firstNameOf(profile.displayName);
  const directory =
    jurisdictionId === null
      ? "/find-an-attorney"
      : `/find-an-attorney?jurisdiction=${jurisdictionId}`;
  const talkNow =
    jurisdictionId !== null && profile.availableNow
      ? selectionPath({
          attorneyId: attorney,
          jurisdictionId,
          practiceAreaId: null,
          availability: "instant",
          page: 1,
        })
      : null;
  const schedule =
    jurisdictionId !== null && profile.windows.length > 0
      ? selectionPath({
          attorneyId: attorney,
          jurisdictionId,
          practiceAreaId: null,
          availability: "scheduled",
          page: 1,
        })
      : null;
  return (
    <SitePage session={shell.session} signOut={signOut}>
      <section className="wrap pg l-pt28 rz-section-end rz-profile">
        <nav className="crumbs" aria-label="Breadcrumb">
          <a href="/">Home</a>
          <span aria-hidden="true">/</span>
          <a href={directory}>Find an attorney</a>
          <span aria-hidden="true">/</span>
          <span className="l-cink" aria-current="page">
            {profile.displayName}
          </span>
        </nav>
        <div className="pm2 l-mt14" aria-labelledby="profile-title">
          <div className="pm2-l">
            <div className="pm2-head">
              <div className="pm-portrait rz-portrait">
                <span className="rz-portrait__initials" aria-hidden="true">
                  {initialsOf(profile.displayName)}
                </span>
              </div>
              <div className="stack l-g0-minw0">
                <div className="row l-g8-fwrwrap">
                  {profile.availableNow ? (
                    <span className="pill ok">
                      <i />
                      {AVAILABLE_NOW}
                    </span>
                  ) : null}
                </div>
                <h1
                  className="h2 l-fs32-mt12"
                  data-rz="profile.title"
                  id="profile-title"
                >
                  {profile.displayName}
                </h1>
                {profile.practiceAreas.length === 0 ? null : (
                  <p className="sm l-mt4-fs15-fw500-cink-2">
                    {profile.practiceAreas[0]}
                  </p>
                )}
                {profile.headline === null ? null : (
                  <p className="body l-mt8-fs15_5">{profile.headline}</p>
                )}
                {reviews === null || reviews.count === 0 ? null : (
                  <div className="row l-g14-mt12-fwrwrap">
                    <a className="rev link l-fw600" href="#pm-reviews">
                      {`${reviews.count} published ${reviews.count === 1 ? "review" : "reviews"}${
                        reviews.average === null
                          ? ""
                          : `, average rating ${reviews.average.toFixed(1)} of 5`
                      }`}
                    </a>
                  </div>
                )}
              </div>
            </div>
            <dl className="pm2-facts">
              {years === null ? null : (
                <div>
                  <dt>Experience</dt>
                  <dd>{years}</dd>
                </div>
              )}
              <div>
                <dt>Listed in</dt>
                <dd>{profile.jurisdictions.map((j) => j.name).join(", ")}</dd>
              </div>
            </dl>
            {profile.bio === null ? null : (
              <section className="pm2-sec" aria-labelledby="pm-about">
                <h2 className="lbl-sm" id="pm-about">
                  About
                </h2>
                <p className="body prose-pl l-mt8-cink-2-fs15">{profile.bio}</p>
              </section>
            )}
            {profile.practiceAreas.length === 0 ? null : (
              <section className="pm2-sec" aria-labelledby="pm-areas">
                <h2 className="lbl-sm" id="pm-areas">
                  Practice areas
                </h2>
                <div className="row l-g6-mt10-fwrwrap">
                  {profile.practiceAreas.map((area) => (
                    <span className="tag l-h26" key={area}>
                      {area}
                    </span>
                  ))}
                </div>
              </section>
            )}
            {reviews === null || reviews.count === 0 ? null : (
              <section
                className="pm2-sec"
                id="pm-reviews"
                aria-labelledby="pm-rev-h"
              >
                <h2 className="lbl-sm" id="pm-rev-h">
                  Client reviews
                </h2>
                <p className="xs subtle l-mt8">{PUBLIC_REVIEWS_NOTE}</p>
                <div className="stack l-g0-mt8">
                  {reviews.reviews.map((review, index) => (
                    <div
                      className="pm-rev"
                      key={`${review.publishedAt}-${index}`}
                    >
                      <div className="row between">
                        <span className="sm l-fw600">
                          {`Rating: ${RATING_LABELS[review.rating]}`}
                        </span>
                        <span className="xs subtle">
                          {`Published ${utcText(review.publishedAt)}`}
                        </span>
                      </div>
                      {review.text === null ? null : (
                        <p className="sm l-mt6-cink-2">{review.text}</p>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
          <aside className="pm2-r" aria-label="Request a consultation">
            <div className="pm2-rh">
              <div className="stack l-g2-pr48">
                <p className="h4 l-fs17">Request a consultation</p>
                <p className="xs subtle">
                  Nothing is booked until {first} accepts.
                </p>
              </div>
            </div>
            <div className="pm2-rb">
              {jurisdictionId === null ? (
                <div className="well l-p16-18-r12">
                  <p className="sm">{PROFILE_JURISDICTION_NOTE}</p>
                  <a className="btn btn-line btn-sm l-mt10" href={directory}>
                    Choose a state in the directory
                  </a>
                </div>
              ) : talkNow === null && schedule === null ? (
                <div className="well l-p16-18-r12">
                  <p className="sm l-fw600">Not taking requests right now</p>
                </div>
              ) : (
                <>
                  <p className="sm l-fw600">How would you like to talk?</p>
                  <div className="stack l-g8-mt10">
                    {talkNow === null ? null : (
                      <a className="choice" href={talkNow}>
                        <span className="ci l-bge9f6ee">
                          <span className="dot" />
                        </span>
                        <span className="stack l-g2-f1">
                          <span className="sm l-fw600">Talk now</span>
                          <span className="xs subtle">{AVAILABLE_NOW}</span>
                        </span>
                      </a>
                    )}
                    {schedule === null ? null : (
                      <a className="choice" href={schedule}>
                        <span className="ci" aria-hidden="true" />
                        <span className="stack l-g2-f1">
                          <span className="sm l-fw600">Schedule a time</span>
                          <span className="xs subtle">
                            Choose one of the open times
                          </span>
                        </span>
                      </a>
                    )}
                  </div>
                </>
              )}
              <p className="lbl-sm l-mt22">Lengths and fees · set by {first}</p>
              {offers.length === 0 ? (
                <p className="sm muted l-mt6">{NO_OFFERS}</p>
              ) : (
                <>
                  <div className="stack divide l-mt6">
                    {offers.map((offer) => (
                      <div
                        className="row between l-p9-0"
                        key={`${offer.modality}-${offer.durationMinutes}-${offer.currency}`}
                      >
                        <span className="sm">{offerText(offer)}</span>
                      </div>
                    ))}
                  </div>
                  <p className="xs subtle l-mt8">
                    {jurisdictionId === null
                      ? OFFERS_JURISDICTION_NOTE
                      : OFFERS_NOTE}
                  </p>
                </>
              )}
              <p className="lbl-sm l-mt22">Open times</p>
              {jurisdictionId === null ? (
                <p className="sm muted l-mt6">{PROFILE_JURISDICTION_NOTE}</p>
              ) : profile.windows.length === 0 ? (
                <p className="sm muted l-mt6">{NO_WINDOWS}</p>
              ) : (
                <>
                  <ul className="stack divide l-mt6">
                    {profile.windows.map((window) => (
                      <li className="sm l-p9-0" key={window.startsAt}>
                        {`${utcText(window.startsAt)} to ${utcText(window.endsAt)}`}
                      </li>
                    ))}
                  </ul>
                  <p className="xs subtle l-mt8">{WINDOWS_NOTE}</p>
                </>
              )}
              <a className="link sm l-mt22" href={directory}>
                Back to the directory
              </a>
            </div>
          </aside>
        </div>
      </section>
    </SitePage>
  );
}
