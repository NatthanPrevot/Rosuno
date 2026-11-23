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

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveAttorneyQueue } from "../../../src/application/attorney-requests.ts";
import { resolveAttorneySchedule } from "../../../src/application/attorney-schedule.ts";
import { resolveAttorneyEarnings } from "../../../src/application/client-payments.ts";
import { resolveAttorneyComplaints } from "../../../src/application/complaints.ts";
import {
  attorneyConsultationPathFor,
  displayStateOf,
  resolveAttorneyConsultations,
  type ConsultationEntry,
} from "../../../src/application/consultations.ts";
import { resolveAttorneyNotifications } from "../../../src/application/notification-center.ts";
import {
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
  ATTORNEY_STATE_LABELS,
  modalityText,
  PATH_LABELS,
} from "../../../src/presentation/consultation-labels.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Eyebrow,
  Heading,
  Page,
  Stack,
  Status,
  Surface,
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
  utcText,
} from "../../../src/presentation/workspace-labels.ts";
import { AttorneyNavigation } from "../../../src/presentation/workspace-navigation.tsx";
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

function Frame({ children }: { readonly children: ReactNode }) {
  return (
    <Page density="attorney">
      <Surface emphasis="raised" labelledBy="attorney-dashboard-title">
        <Stack>
          <Eyebrow>Attorney workspace</Eyebrow>
          <Heading as="h1" size="lg" id="attorney-dashboard-title">
            Dashboard
          </Heading>
          {children}
          <AttorneyNavigation current="/attorney/dashboard" />
        </Stack>
      </Surface>
    </Page>
  );
}

function SectionOf<T>({
  id,
  title,
  section,
  links,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly section: Section<T>;
  readonly links: ReactNode;
  readonly children: (value: T) => ReactNode;
}) {
  return (
    <Surface labelledBy={id}>
      <Stack gap="tight">
        <Heading as="h2" size="md" id={id}>
          {title}
        </Heading>
        {section.status === "ready" ? (
          children(section.value)
        ) : (
          <Text tone="muted">{SECTION_UNAVAILABLE}</Text>
        )}
        <Cluster>{links}</Cluster>
      </Stack>
    </Surface>
  );
}

function ConsultationLine({ entry }: { readonly entry: ConsultationEntry }) {
  const state = ATTORNEY_STATE_LABELS[displayStateOf(entry)];
  return (
    <Cluster>
      <Status tone={state.tone}>{state.label}</Status>
      <Text size="small">
        {entry.bookingStart !== null
          ? `${modalityText(entry.modality)}, ${utcText(entry.bookingStart)}`
          : `${modalityText(entry.modality)}, ${PATH_LABELS[entry.path]}`}
      </Text>
      <ButtonLink
        variant="tertiary"
        href={attorneyConsultationPathFor(entry.id)}
      >
        Open the consultation
      </ButtonLink>
    </Cluster>
  );
}

export default async function AttorneyDashboardPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const view = await resolveAttorneyDashboard(DASHBOARD_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <Frame>
        <Text tone="muted">
          The dashboard is available only to a signed-in account with attorney
          access.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </Frame>
    );
  }
  if (view.status === "denied") {
    return (
      <Frame>
        <Alert tone="warning" title="Not available" role="status">
          This account does not have access to the attorney workspace.
        </Alert>
      </Frame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "attorney_dashboard.unavailable", {
      route: "/attorney/dashboard",
      outcome: view.status,
    });
    return (
      <Frame>
        <Alert tone="error" title="Something went wrong" role="alert">
          Your dashboard could not be shown right now. Please try again later.
        </Alert>
      </Frame>
    );
  }
  const { dashboard } = view;
  return (
    <Frame>
      <Text tone="muted">{DASHBOARD_INTRO}</Text>
      <Text tone="muted">{TIMES_NOTE}</Text>
      <SectionOf
        id="dashboard-consultations"
        title="Consultations"
        section={dashboard.consultations}
        links={
          <ButtonLink variant="secondary" href="/attorney/consultations">
            All current consultations
          </ButtonLink>
        }
      >
        {(value) => (
          <Stack gap="tight">
            {value.active.length === 0 && value.next === null ? (
              <Text>No consultation is in progress or coming up.</Text>
            ) : null}
            {value.active.map((entry) => (
              <ConsultationLine key={entry.id} entry={entry} />
            ))}
            {value.next === null ? null : (
              <>
                <Text size="small" tone="muted">
                  Next consultation
                </Text>
                <ConsultationLine entry={value.next} />
              </>
            )}
          </Stack>
        )}
      </SectionOf>
      <SectionOf
        id="dashboard-requests"
        title="Requests"
        section={dashboard.requests}
        links={
          <ButtonLink variant="secondary" href="/attorney/requests">
            Requests awaiting your decision
          </ButtonLink>
        }
      >
        {(value) => <Text>{pendingText(value.instant, value.scheduled)}</Text>}
      </SectionOf>
      <SectionOf
        id="dashboard-availability"
        title="Availability"
        section={dashboard.availability}
        links={
          <>
            <ButtonLink variant="secondary" href="/attorney/schedule">
              Schedule
            </ButtonLink>
            <ButtonLink variant="secondary" href="/attorney/schedule/week">
              Week view
            </ButtonLink>
          </>
        }
      >
        {(value) => (
          <Stack gap="tight">
            <Text>{instantText(value.instantOn, value.instantConfigured)}</Text>
            <Text>{availabilityText(value.windows, value.days)}</Text>
            {value.nextWindow === null ? null : (
              <Text size="small">
                {`Next availability: ${formatInZone(value.nextWindow.startsAt, value.nextWindow.timezone ?? "UTC")}`}
              </Text>
            )}
            {value.blackouts === 0 ? null : (
              <Text size="small">{`${value.blackouts} blackout(s) in the same period.`}</Text>
            )}
          </Stack>
        )}
      </SectionOf>
      <SectionOf
        id="dashboard-earnings"
        title="Earnings"
        section={dashboard.earnings}
        links={
          <ButtonLink variant="secondary" href="/attorney/earnings">
            Earnings
          </ButtonLink>
        }
      >
        {(value) => (
          <Stack gap="tight">
            <Text size="small" tone="muted">
              {EARNINGS_NOTE}
            </Text>
            {value.totals.length === 0 ? (
              <Text>{NO_EARNINGS}</Text>
            ) : (
              value.totals.map((total) => (
                <Text key={total.currency}>
                  {moneyText(total.netMinor, total.currency)}
                </Text>
              ))
            )}
          </Stack>
        )}
      </SectionOf>
      <SectionOf
        id="dashboard-alerts"
        title="Alerts"
        section={dashboard.alerts}
        links={
          <>
            <ButtonLink variant="secondary" href="/attorney/notifications">
              Notifications
            </ButtonLink>
            <ButtonLink variant="secondary" href="/attorney/complaints">
              Reported problems
            </ButtonLink>
            <ButtonLink variant="secondary" href="/attorney/compliance">
              Compliance
            </ButtonLink>
          </>
        }
      >
        {(value) => (
          <Stack gap="tight">
            <Text>{unacknowledgedText(value.unacknowledged)}</Text>
            <Text>{openComplaintsText(value.openComplaints)}</Text>
            {value.compliance === null ? (
              <Text tone="muted">
                Your compliance records could not be read right now.
              </Text>
            ) : (
              <>
                <Text size="small" tone="muted">
                  {COMPLIANCE_ALERT_NOTE}
                </Text>
                {value.compliance.lapsed === 0 ? null : (
                  <Status tone="warning">
                    {lapsedText(value.compliance.lapsed)}
                  </Status>
                )}
                {value.compliance.evidenceAged === 0 ? null : (
                  <Status tone="warning">
                    {evidenceAgedText(value.compliance.evidenceAged)}
                  </Status>
                )}
                {value.compliance.openFindings === 0 ? null : (
                  <Status tone="information">
                    {openFindingsText(value.compliance.openFindings)}
                  </Status>
                )}
                <Text>{nextDateText(value.compliance.nextDate)}</Text>
              </>
            )}
          </Stack>
        )}
      </SectionOf>
    </Frame>
  );
}
