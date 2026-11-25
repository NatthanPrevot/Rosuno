// The attorney's week view (MVP-001 S11 pass 2B; MBS section 18.3
// "schedule").
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell, and seven UTC days of the attorney's own calendar are shown from
// the existing calendar read (of those days and one local day on each side):
// availability windows, Blackouts, Holds for pending requests and Bookings. The one query value read, week, only names
// the first day shown; the server checks it against the span the calendar
// read answers and shows the current week for anything else. Read-only: the
// schedule is changed on the existing schedule page. Nothing of a client, a
// request or an Intake is shown. A view unavailable is logged with the route
// and outcome only.
//
// DEV-001: the owner's UI/UX design (UIUX-HANDOFF-P2 build_p8, the attorney
// workspace Calendar, agenda view): the workspace frame around the design's
// seven-day agenda (each UTC day with its entries and their meaning in
// words) and its legend; the week links are the existing ones. A visitor the
// page does not admit sees the design's signed-out panel.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveScheduleWeek } from "../../../../src/application/participant-workspaces.ts";
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
import { ATTORNEY_SCHEDULE_SOURCES } from "../../../../src/infrastructure/scheduling/attorney-schedule-adapter.ts";
import {
  AttorneyGate,
  AttorneyWorkspace,
  dayText,
  TIMES_IN_UTC,
} from "../../../../src/presentation/attorney-workspace.tsx";
import {
  Alert,
  ButtonLink,
  Cluster,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import {
  ENTRY_LABELS,
  formatInZone,
  formatUtc,
} from "../../../../src/presentation/schedule-labels.ts";
import {
  NO_ENTRIES,
  WEEK_INTRO,
} from "../../../../src/presentation/workspace-labels.ts";
import { requireSteppedUp } from "../../../account/gate.ts";

export const metadata: Metadata = {
  title: "Week view",
  robots: { index: false, follow: false },
};

// The design's calendar semantics for each entry kind.
const ENTRY_BARS = Object.freeze({
  window: "w-tlb sem-open",
  blackout: "w-tlb sem-off",
  hold: "w-tlb sem-hold",
  booking: "w-tlb sem-conf",
} as const);

function GateFrame({ children }: { readonly children: ReactNode }) {
  return (
    <AttorneyGate titleId="attorney-week-title" title="Week view">
      {children}
    </AttorneyGate>
  );
}

function weekHref(start: string): string {
  return `/attorney/schedule/week?week=${start}`;
}

export default async function AttorneyWeekPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly week?: string | string[] }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const { week } = await searchParams;
  const view = await resolveScheduleWeek(ATTORNEY_SCHEDULE_SOURCES, week);
  if (view.status === "sign-in-required") {
    return (
      <GateFrame>
        <Text tone="muted">
          The week view is available only to a signed-in account with attorney
          access.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </GateFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <GateFrame>
        <Alert tone="warning" title="Not available" role="status">
          This account does not have an attorney schedule.
        </Alert>
      </GateFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "scheduling.view_unavailable", {
      route: "/attorney/schedule/week",
      outcome: view.status,
    });
    return (
      <GateFrame>
        <Alert tone="error" title="Something went wrong" role="alert">
          The week view could not be shown right now. Please try again later.
        </Alert>
      </GateFrame>
    );
  }
  return (
    <AttorneyWorkspace
      section="calendar"
      titleId="attorney-week-title"
      title="Calendar"
      width="wide"
    >
      <p className="xs subtle aw-lead">{WEEK_INTRO}</p>
      <div className="w-ph aw-weekbar">
        <h2 className="w-h2 w-crange" id="attorney-week-range">
          {`Seven days from ${view.start} (UTC)`}
        </h2>
        <span className="grow"></span>
        <Cluster>
          {view.previous === null ? null : (
            <ButtonLink variant="secondary" href={weekHref(view.previous)}>
              Previous week
            </ButtonLink>
          )}
          {view.start === view.today ? null : (
            <ButtonLink variant="secondary" href={weekHref(view.today)}>
              This week
            </ButtonLink>
          )}
          {view.next === null ? null : (
            <ButtonLink variant="secondary" href={weekHref(view.next)}>
              Next week
            </ButtonLink>
          )}
        </Cluster>
      </div>
      <section
        className="w-box w-calbox aw-calbox"
        aria-labelledby="attorney-week-range"
      >
        <div className="w-ag">
          {view.days.map((day) => (
            <section
              className={day.date === view.today ? "w-agd today" : "w-agd"}
              key={day.date}
              aria-label={day.date}
            >
              <div className="w-agh">
                <span className="sm b">{dayText(`${day.date}T00:00:00Z`)}</span>
                {day.date === view.today ? (
                  <span className="tag">Today</span>
                ) : null}
                <span className="grow"></span>
                <span className="xs subtle">{day.date}</span>
              </div>
              {day.entries.length === 0 ? (
                <p className="xs subtle aw-agnone">{NO_ENTRIES}</p>
              ) : (
                day.entries.map((entry) => (
                  <div
                    className="w-agr"
                    key={`${entry.kind}-${entry.id}-${entry.startsAt}`}
                  >
                    <span className="xs num muted">{`${formatUtc(entry.startsAt).slice(11, 16)}–${formatUtc(entry.endsAt).slice(11, 16)} UTC`}</span>
                    <i
                      className={ENTRY_BARS[entry.kind]}
                      aria-hidden="true"
                    ></i>
                    <span className="col grow l-g0-minw0">
                      <span className="sm b ell">
                        {ENTRY_LABELS[entry.kind]}
                      </span>
                      <span className="xs muted ell">
                        {entry.timezone === null
                          ? `${formatUtc(entry.startsAt)} to ${formatUtc(entry.endsAt)}`
                          : `${formatInZone(entry.startsAt, entry.timezone)} to ${formatInZone(entry.endsAt, entry.timezone)}`}
                      </span>
                    </span>
                  </div>
                ))
              )}
            </section>
          ))}
        </div>
        <div className="w-legend" aria-label="Legend">
          <span>
            <i className="lg sem-conf" aria-hidden="true"></i>
            {ENTRY_LABELS.booking}
          </span>
          <span>
            <i className="lg sem-hold" aria-hidden="true"></i>
            {ENTRY_LABELS.hold}
          </span>
          <span>
            <i className="lg sem-off" aria-hidden="true"></i>
            {ENTRY_LABELS.blackout}
          </span>
          <span>
            <i className="lg w-lgopen" aria-hidden="true"></i>
            {ENTRY_LABELS.window}
          </span>
          <span className="grow"></span>
          <span className="subtle">{TIMES_IN_UTC}</span>
        </div>
      </section>
      <Cluster>
        <ButtonLink variant="secondary" href="/attorney/schedule">
          Change your schedule
        </ButtonLink>
      </Cluster>
    </AttorneyWorkspace>
  );
}
