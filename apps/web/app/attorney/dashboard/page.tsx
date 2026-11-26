// The attorney's dashboard (MVP-001 S11 pass 2B; MBS section 18.3 "home /
// dashboard").
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell. Each section is read by its existing use case with its own
// production sources, each deciding access again: the current and next
// Consultations, the Requests awaiting a decision, Instant mode and the
// availability of the next 14 days, the ledger-derived earnings, and the
// alerts (notifications waiting for an acknowledgement, reported problems not
// resolved, and what the attorney's own records say today with no reminder
// period applied). A section that cannot be read says so and the others are
// still shown. Nothing of a client's identity is shown; nothing changes here.
//
// DEV-001: the owner's UI/UX design (UIUX-HANDOFF-P2 build_p8, the attorney
// workspace Overview): the workspace frame around the design's cards. The
// queue the Requests section reads and the Consultation list the
// Consultations section reads are kept as their own use cases answered them
// (the same single read each, through the same sources), so the design's
// "Needs your attention" and "Coming up" lists show their entries; the
// server clock the dashboard reads is kept likewise to draw the countdown
// ring. A visitor the page does not admit sees the design's signed-out panel.
//
// DEV-001: the design's performance panel, for the calendar month in UTC of
// that same server clock reading (no other clock is read): the Requests the
// attorney received in the month by outcome, "answered" being accepted and
// declined, and the Consultations that ended in it by outcome, read after the
// dashboard through the attorney's own activity counts
// (attorney_activity_counts, behind the Security Shell again). Counts only:
// no rate, rating, ranking or score. Beside them, the ledger-derived net of
// the earnings section, per currency and never added across currencies. When
// the counts cannot be read the panel says so and one log line with no
// attorney data is written; the rest of the dashboard is still shown.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  attorneyRequestPathFor,
  resolveAttorneyQueue,
  type AttorneyQueueView,
  type QueueEntry,
} from "../../../src/application/attorney-requests.ts";
import { resolveAttorneySchedule } from "../../../src/application/attorney-schedule.ts";
import { resolveAttorneyEarnings } from "../../../src/application/client-payments.ts";
import { resolveAttorneyComplaints } from "../../../src/application/complaints.ts";
import {
  attorneyConsultationPathFor,
  displayStateOf,
  resolveAttorneyConsultations,
  type ConsultationEntry,
  type ConsultationListView,
} from "../../../src/application/consultations.ts";
import { resolveAttorneyNotifications } from "../../../src/application/notification-center.ts";
import {
  resolveAttorneyActivity,
  resolveAttorneyComplianceRecords,
  resolveAttorneyDashboard,
  type AttorneyDashboardSources,
  type Section,
} from "../../../src/application/participant-workspaces.ts";
import { ATTORNEY_CENTER_SOURCES } from "../../../src/infrastructure/communications/communication-adapter.ts";
import { ATTORNEY_COMPLAINT_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { ATTORNEY_CONSULTATION_SOURCES } from "../../../src/infrastructure/consultations/consultation-adapter.ts";
import { ATTORNEY_PRINCIPAL_SOURCE } from "../../../src/infrastructure/identity/attorney-principal-source.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../src/infrastructure/identity/server-session-source.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { EARNINGS_SOURCES } from "../../../src/infrastructure/payments/payment-adapter.ts";
import { ATTORNEY_REQUEST_SOURCES } from "../../../src/infrastructure/requests/attorney-request-adapter.ts";
import { ATTORNEY_SCHEDULE_SOURCES } from "../../../src/infrastructure/scheduling/attorney-schedule-adapter.ts";
import { ATTORNEY_WORKSPACE_SOURCES } from "../../../src/infrastructure/workspaces/workspace-adapter.ts";
import {
  ActivityPanel,
  AttorneyGate,
  AttorneyWorkspace,
  Calm,
  Card,
  clockText,
  CountdownRing,
  DateBadge,
  dayText,
  monthPeriodOf,
  monthText,
  Pill,
  ringStepOf,
  whenText,
} from "../../../src/presentation/attorney-workspace.tsx";
import {
  ATTORNEY_STATE_LABELS,
  durationText,
  modalityText,
  PATH_LABELS,
} from "../../../src/presentation/consultation-labels.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { formatInZone } from "../../../src/presentation/schedule-labels.ts";
import {
  availabilityText,
  COMPLIANCE_ALERT_NOTE,
  DASHBOARD_INTRO,
  EARNINGS_NOTE,
  evidenceAgedText,
  instantText,
  lapsedText,
  moneyText,
  nextDateText,
  NO_EARNINGS,
  openComplaintsText,
  openFindingsText,
  pendingText,
  SECTION_UNAVAILABLE,
  TIMES_NOTE,
  unacknowledgedText,
} from "../../../src/presentation/workspace-labels.ts";
import { requireSteppedUp } from "../../account/gate.ts";

export const metadata: Metadata = {
  title: "Attorney dashboard",
  robots: { index: false, follow: false },
};

// Each section's existing use case, bound to its own production sources.
const DASHBOARD_SOURCES: AttorneyDashboardSources = Object.freeze({
  session: SUPABASE_SERVER_SESSION_SOURCE,
  attorney: ATTORNEY_PRINCIPAL_SOURCE,
  consultations: () =>
    resolveAttorneyConsultations(ATTORNEY_CONSULTATION_SOURCES),
  requests: () => resolveAttorneyQueue(ATTORNEY_REQUEST_SOURCES),
  schedule: () => resolveAttorneySchedule(ATTORNEY_SCHEDULE_SOURCES),
  earnings: () => resolveAttorneyEarnings(EARNINGS_SOURCES),
  notifications: () => resolveAttorneyNotifications(ATTORNEY_CENTER_SOURCES),
  complaints: () => resolveAttorneyComplaints(ATTORNEY_COMPLAINT_SOURCES),
  compliance: () =>
    resolveAttorneyComplianceRecords(ATTORNEY_WORKSPACE_SOURCES),
  clock: ATTORNEY_SCHEDULE_SOURCES.clock,
});

// DEV-001: what this request's dashboard read through its own sources, kept
// for the design's lists (each source still runs once, as the dashboard asks).
type Kept = {
  queue?: AttorneyQueueView;
  consultations?: ConsultationListView;
  now?: number;
};

function keepingSources(kept: Kept): AttorneyDashboardSources {
  return Object.freeze({
    ...DASHBOARD_SOURCES,
    consultations: async () =>
      (kept.consultations = await DASHBOARD_SOURCES.consultations()),
    requests: async () => (kept.queue = await DASHBOARD_SOURCES.requests()),
    clock: () => (kept.now = DASHBOARD_SOURCES.clock()),
  });
}

function GateFrame({ children }: { readonly children: ReactNode }) {
  return (
    <AttorneyGate titleId="attorney-dashboard-title" title="Dashboard">
      {children}
    </AttorneyGate>
  );
}

function Unavailable() {
  return <Text tone="muted">{SECTION_UNAVAILABLE}</Text>;
}

function readyOf<T>(section: Section<T>): T | null {
  return section.status === "ready" ? section.value : null;
}

function consultationText(entry: ConsultationEntry): string {
  return entry.durationMinutes === null
    ? modalityText(entry.modality)
    : `${modalityText(entry.modality)} · ${durationText(entry.durationMinutes)}`;
}

// One Request awaiting the attorney: the consultation asked for, its timing
// and the server's latest time to decide. Nothing about the client is shown
// before acceptance.
function QueueRow({
  entry,
  now,
}: {
  readonly entry: QueueEntry;
  readonly now: number | null;
}) {
  const instant = entry.path === "instant";
  const window =
    entry.decideBy === null
      ? NaN
      : Date.parse(entry.decideBy) - Date.parse(entry.createdAt);
  const remaining =
    entry.decideBy === null || now === null
      ? NaN
      : Date.parse(entry.decideBy) - now;
  const minutes = Math.max(Math.ceil(remaining / 60000), 0);
  return (
    <div className={instant ? "w-qr u" : "w-qr"}>
      {instant && Number.isFinite(remaining) ? (
        <CountdownRing step={ringStepOf(remaining, window)}>
          {minutes < 1 ? "<1m" : `${minutes}m`}
        </CountdownRing>
      ) : entry.slotStart !== null ? (
        <DateBadge timestamp={entry.slotStart} />
      ) : null}
      <div className="col grow l-g1-minw0">
        <span className="row l-g6-minw0">
          <span className="sm b ell">{`${modalityText(entry.modality)} · ${durationText(entry.durationMinutes)}`}</span>
          <span className={instant ? "kind urgent" : "kind scheduled"}>
            {instant ? "Talk Now" : "Scheduled"}
          </span>
        </span>
        <span className="xs muted ell">
          {entry.slotStart === null
            ? PATH_LABELS[entry.path]
            : whenText(entry.slotStart)}
        </span>
        {entry.decideBy === null ? null : (
          <span className={instant ? "xs w-qmeta u" : "xs w-qmeta"}>
            {`Respond by ${whenText(entry.decideBy)}`}
          </span>
        )}
      </div>
      <a
        className="btn btn-line btn-sm"
        href={attorneyRequestPathFor(entry.id)}
      >
        Review
      </a>
    </div>
  );
}

// One upcoming Consultation in the design's "Coming up" row.
function ComingRow({ entry }: { readonly entry: ConsultationEntry }) {
  const state = ATTORNEY_STATE_LABELS[displayStateOf(entry)];
  return (
    <a className="w-upr" href={attorneyConsultationPathFor(entry.id)}>
      {entry.bookingStart === null ? null : (
        <DateBadge timestamp={entry.bookingStart} />
      )}
      <span className="col grow l-g0-minw0">
        <span className="sm b ell">
          {entry.bookingStart === null
            ? PATH_LABELS[entry.path]
            : clockText(entry.bookingStart)}
        </span>
        <span className="xs muted ell">{consultationText(entry)}</span>
      </span>
      <span className="tag">{state.label}</span>
    </a>
  );
}

// The consultation in progress, or the next one: the design's "Next up".
function NextUp({ entry }: { readonly entry: ConsultationEntry }) {
  const shown = displayStateOf(entry);
  const state = ATTORNEY_STATE_LABELS[shown];
  const active = shown === "live" || shown === "ready";
  return (
    <div className="w-next">
      <div className="row between l-g8">
        <span className="lbl">
          {active
            ? "Now"
            : entry.bookingStart === null
              ? "Next up"
              : `Next up · ${dayText(entry.bookingStart)}`}
        </span>
        <Pill tone={state.tone}>{state.label}</Pill>
      </div>
      <div className="row aw-next-time">
        <span className="w-ntime num">
          {entry.bookingStart === null
            ? PATH_LABELS[entry.path]
            : clockText(entry.bookingStart)}
        </span>
      </div>
      <p className="xs muted">{consultationText(entry)}</p>
      <div className="row aw-next-acts">
        <a
          className={active ? "btn btn-ink btn-sm" : "btn btn-quiet btn-sm"}
          href={attorneyConsultationPathFor(entry.id)}
        >
          {active ? "Join" : "Details"}
        </a>
        {active ? null : (
          <span className="xs subtle grow aw-next-note">
            Join opens when the room opens
          </span>
        )}
      </div>
    </div>
  );
}

export default async function AttorneyDashboardPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const kept: Kept = {};
  const view = await resolveAttorneyDashboard(keepingSources(kept));
  if (view.status === "sign-in-required") {
    return (
      <GateFrame>
        <Text tone="muted">
          The dashboard is available only to a signed-in account with attorney
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
          This account does not have access to the attorney workspace.
        </Alert>
      </GateFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "attorney_dashboard.unavailable", {
      route: "/attorney/dashboard",
      outcome: view.status,
    });
    return (
      <GateFrame>
        <Alert tone="error" title="Something went wrong" role="alert">
          Your dashboard could not be shown right now. Please try again later.
        </Alert>
      </GateFrame>
    );
  }
  const { dashboard } = view;
  const requests = readyOf(dashboard.requests);
  const consultations = readyOf(dashboard.consultations);
  const availability = readyOf(dashboard.availability);
  const earnings = readyOf(dashboard.earnings);
  const alerts = readyOf(dashboard.alerts);
  // The Requests the summary counts (one the server reports past its
  // deadline is not counted), as the queue listed them.
  const queue =
    requests !== null && kept.queue?.status === "ready"
      ? kept.queue.entries.filter((entry) => !entry.expiredDue)
      : [];
  const waiting =
    requests === null ? null : requests.instant + requests.scheduled;
  const now =
    kept.now !== undefined && Number.isFinite(kept.now) ? kept.now : null;
  // DEV-001: the owner's UI/UX design's performance panel: the calendar month
  // in UTC of the dashboard's own clock reading, read after the dashboard.
  const period = monthPeriodOf(now);
  const activity = await resolveAttorneyActivity(
    ATTORNEY_WORKSPACE_SOURCES,
    period,
  );
  if (activity.status !== "ready") {
    await logRequestEvent("warn", "attorney_dashboard.unavailable", {
      route: "/attorney/dashboard",
      operation: "resolveAttorneyActivity",
      outcome: activity.status,
    });
  }
  // Every upcoming Consultation of the list, in its order.
  const coming =
    consultations !== null && kept.consultations?.status === "ready"
      ? kept.consultations.entries.filter(
          (entry) =>
            displayStateOf(entry) === "scheduled" &&
            entry.bookingStart !== null,
        )
      : [];
  const current =
    consultations === null
      ? null
      : (consultations.active[0] ?? consultations.next);
  return (
    <AttorneyWorkspace
      section="dashboard"
      titleId="attorney-dashboard-title"
      title="Overview"
      description={TIMES_NOTE}
      talk={availability === null ? null : availability.instantOn}
      waiting={waiting}
    >
      <p className="xs subtle aw-lead">{DASHBOARD_INTRO}</p>
      <div className="w-ov">
        <Card
          id="dashboard-requests"
          title="Needs your attention"
          count={waiting === null || waiting === 0 ? undefined : waiting}
          link={{ href: "/attorney/requests", label: "All requests" }}
          place="w-z7 w-att"
        >
          {requests === null ? (
            <Unavailable />
          ) : (
            <div className="w-ql">
              {queue.length === 0 ? (
                <Calm
                  title="You’re all caught up"
                  note={pendingText(requests.instant, requests.scheduled)}
                />
              ) : (
                queue.map((entry) => (
                  <QueueRow key={entry.id} entry={entry} now={now} />
                ))
              )}
            </div>
          )}
        </Card>
        <Card
          id="dashboard-consultations"
          title="Up next"
          link={{ href: "/attorney/schedule/week", label: "Calendar" }}
          place="w-z5 w-today"
        >
          {consultations === null ? (
            <Unavailable />
          ) : current === null ? (
            <Calm
              title="No consultations coming up"
              note="Accepted requests appear here."
            />
          ) : (
            <>
              <NextUp entry={current} />
              {consultations.active.length > 1 ? (
                <p className="xs muted">{`${consultations.active.length} consultations are in progress or ready to start.`}</p>
              ) : null}
            </>
          )}
        </Card>
        <Card
          id="dashboard-performance"
          title="Performance"
          link={{ href: "/attorney/earnings", label: "Earnings" }}
          place="w-z7 w-perf"
        >
          <ActivityPanel
            month={period === null ? null : monthText(period.from)}
            activity={activity.status === "ready" ? activity.activity : null}
          />
          <p className="lbl aw-perf-ledger">Earnings in the ledger</p>
          {earnings === null ? (
            <Unavailable />
          ) : earnings.totals.length === 0 ? (
            <Calm title={NO_EARNINGS} />
          ) : (
            <div className="w-kpis">
              {earnings.totals.map((total) => (
                <div className="w-kpi" key={total.currency}>
                  <span className="xs muted">{`Net, ${total.currency}`}</span>
                  <b className="num">
                    {moneyText(total.netMinor, total.currency)}
                  </b>
                  <span className="xs subtle">Recorded in the ledger</span>
                </div>
              ))}
            </div>
          )}
          <div className="row w-defrow">
            <span className="xs subtle grow">{EARNINGS_NOTE}</span>
          </div>
        </Card>
        <Card
          id="dashboard-coming"
          title="Coming up"
          count={consultations === null ? undefined : coming.length}
          link={{
            href: "/attorney/consultations",
            label: "All consultations",
          }}
          place="w-z5 w-up"
        >
          {consultations === null ? (
            <Unavailable />
          ) : (
            <div className="w-uplw">
              <div
                className="w-upl"
                tabIndex={0}
                role="region"
                aria-labelledby="dashboard-coming"
              >
                {coming.length === 0 ? (
                  <p className="sm muted aw-none">Nothing else booked yet.</p>
                ) : (
                  coming.map((entry) => (
                    <ComingRow key={entry.id} entry={entry} />
                  ))
                )}
              </div>
            </div>
          )}
        </Card>
        <Card id="dashboard-alerts" title="Alerts" place="w-rec">
          {alerts === null ? (
            <Unavailable />
          ) : (
            <ul className="w-feed">
              <li>
                <span
                  className={
                    alerts.unacknowledged === 0 ? "w-fd ok" : "w-fd hold"
                  }
                  aria-hidden="true"
                ></span>
                <span className="col grow l-g0-minw0">
                  <span className="sm">
                    {unacknowledgedText(alerts.unacknowledged)}
                  </span>
                </span>
                <a className="link xs" href="/attorney/notifications">
                  Notifications
                </a>
              </li>
              <li>
                <span
                  className={
                    alerts.openComplaints === 0 ? "w-fd ok" : "w-fd hold"
                  }
                  aria-hidden="true"
                ></span>
                <span className="col grow l-g0-minw0">
                  <span className="sm">
                    {openComplaintsText(alerts.openComplaints)}
                  </span>
                </span>
                <a className="link xs" href="/attorney/complaints">
                  Reported problems
                </a>
              </li>
              {alerts.compliance === null ? (
                <li>
                  <span className="w-fd" aria-hidden="true"></span>
                  <span className="col grow l-g0-minw0">
                    <span className="sm muted">
                      Your compliance records could not be read right now.
                    </span>
                  </span>
                  <a className="link xs" href="/attorney/compliance">
                    Compliance
                  </a>
                </li>
              ) : (
                <li>
                  <span
                    className={
                      alerts.compliance.lapsed +
                        alerts.compliance.evidenceAged >
                      0
                        ? "w-fd hold"
                        : "w-fd info"
                    }
                    aria-hidden="true"
                  ></span>
                  <span className="col grow l-g0-minw0 aw-feed-col">
                    <span className="sm">
                      {nextDateText(alerts.compliance.nextDate)}
                    </span>
                    {alerts.compliance.lapsed === 0 ? null : (
                      <Pill tone="warning">
                        {lapsedText(alerts.compliance.lapsed)}
                      </Pill>
                    )}
                    {alerts.compliance.evidenceAged === 0 ? null : (
                      <Pill tone="warning">
                        {evidenceAgedText(alerts.compliance.evidenceAged)}
                      </Pill>
                    )}
                    {alerts.compliance.openFindings === 0 ? null : (
                      <Pill tone="information">
                        {openFindingsText(alerts.compliance.openFindings)}
                      </Pill>
                    )}
                    <span className="xs muted">{COMPLIANCE_ALERT_NOTE}</span>
                  </span>
                  <a className="link xs" href="/attorney/compliance">
                    Compliance
                  </a>
                </li>
              )}
            </ul>
          )}
        </Card>
        <Card
          id="dashboard-availability"
          title="Availability"
          link={{ href: "/attorney/schedule", label: "Schedule" }}
          place="w-z5 w-todo"
        >
          {availability === null ? (
            <Unavailable />
          ) : (
            <div>
              <div className="w-todor">
                <span className="col grow l-g0-minw0">
                  <span className="sm">
                    {instantText(
                      availability.instantOn,
                      availability.instantConfigured,
                    )}
                  </span>
                  <span className="xs muted">
                    Talk Now turns off when you sign out.
                  </span>
                </span>
              </div>
              <div className="w-todor">
                <span className="col grow l-g0-minw0">
                  <span className="sm">
                    {availabilityText(availability.windows, availability.days)}
                  </span>
                  {availability.nextWindow === null ? null : (
                    <span className="xs muted">
                      {`Next availability: ${formatInZone(availability.nextWindow.startsAt, availability.nextWindow.timezone ?? "UTC")}`}
                    </span>
                  )}
                  {availability.blackouts === 0 ? null : (
                    <span className="xs muted">{`${availability.blackouts} blackout(s) in the same period.`}</span>
                  )}
                </span>
                <a className="link sm" href="/attorney/schedule/week">
                  Week view
                </a>
              </div>
            </div>
          )}
        </Card>
      </div>
    </AttorneyWorkspace>
  );
}
