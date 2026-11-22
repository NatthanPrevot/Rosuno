// The attorney's week view (MVP-001 S11 pass 2B; MBS section 18.3
// "schedule").
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell, and seven UTC days of the attorney's own calendar are read through
// the existing calendar read: availability windows, Blackouts, Holds for
// pending requests and Bookings. The one query value read, week, only names
// the first day shown; the server checks it against the span the calendar
// read answers and shows the current week for anything else. Read-only: the
// schedule is changed on the existing schedule page. Nothing of a client, a
// request or an Intake is shown.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveScheduleWeek } from "../../../../src/application/participant-workspaces.ts";
import { ATTORNEY_SCHEDULE_SOURCES } from "../../../../src/infrastructure/scheduling/attorney-schedule-adapter.ts";
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
  Table,
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
import { AttorneyNavigation } from "../../../../src/presentation/workspace-navigation.tsx";
import { requireSteppedUp } from "../../../account/gate.ts";

export const metadata: Metadata = {
  title: "Week view",
  robots: { index: false, follow: false },
};

const ENTRY_TONES = Object.freeze({
  window: "success",
  blackout: "neutral",
  hold: "information",
  booking: "warning",
} as const);

function Frame({ children }: { readonly children: ReactNode }) {
  return (
    <Page density="attorney">
      <Surface emphasis="raised" labelledBy="attorney-week-title">
        <Stack>
          <Eyebrow>Attorney workspace</Eyebrow>
          <Heading as="h1" size="lg" id="attorney-week-title">
            Week view
          </Heading>
          {children}
          <AttorneyNavigation current="/attorney/schedule/week" />
        </Stack>
      </Surface>
    </Page>
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
      <Frame>
        <Text tone="muted">
          The week view is available only to a signed-in account with attorney
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
          This account does not have an attorney schedule.
        </Alert>
      </Frame>
    );
  }
  if (view.status !== "ready") {
    return (
      <Frame>
        <Alert tone="error" title="Something went wrong" role="alert">
          The week view could not be shown right now. Please try again later.
        </Alert>
      </Frame>
    );
  }
  return (
    <Frame>
      <Text tone="muted">{WEEK_INTRO}</Text>
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
      <Table id="attorney-week" caption={`Seven days from ${view.start} (UTC)`}>
        <thead>
          <tr>
            <th scope="col">Day (UTC)</th>
            <th scope="col">Calendar</th>
          </tr>
        </thead>
        <tbody>
          {view.days.map((day) => (
            <tr key={day.date}>
              <th scope="row">{day.date}</th>
              <td>
                {day.entries.length === 0 ? (
                  <Text size="small" tone="muted">
                    {NO_ENTRIES}
                  </Text>
                ) : (
                  <Stack gap="tight">
                    {day.entries.map((entry) => (
                      <Cluster
                        key={`${entry.kind}-${entry.id}-${entry.startsAt}`}
                      >
                        <Status tone={ENTRY_TONES[entry.kind]}>
                          {ENTRY_LABELS[entry.kind]}
                        </Status>
                        <Text size="small">
                          {entry.timezone === null
                            ? `${formatUtc(entry.startsAt)} to ${formatUtc(entry.endsAt)}`
                            : `${formatInZone(entry.startsAt, entry.timezone)} to ${formatInZone(entry.endsAt, entry.timezone)}`}
                        </Text>
                      </Cluster>
                    ))}
                  </Stack>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Cluster>
        <ButtonLink variant="secondary" href="/attorney/schedule">
          Change your schedule
        </ButtonLink>
      </Cluster>
    </Frame>
  );
}
