// Attorney schedule (MVP-001 S4).
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell, and the attorney's own schedule is read from the database: Instant
// mode as the server sees it, the calendar for the next 14 days, the active
// availability rules and the Blackouts not yet ended. Every instant comes
// from the database in UTC and is shown in the time zone it belongs to; the
// page reads no route parameter, query, header, or cookie of its own. The
// heartbeat only asks the server to observe this session; it never declares
// availability. Nothing of a client, a request or an Intake is shown.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  knownTimeZones,
  resolveAttorneySchedule,
  type CalendarEntry,
  type InstantView,
} from "../../../src/application/attorney-schedule.ts";
import { ATTORNEY_SCHEDULE_SOURCES } from "../../../src/infrastructure/scheduling/attorney-schedule-adapter.ts";
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
} from "../../../src/presentation/design-system.tsx";
import {
  ENTRY_LABELS,
  formatInZone,
  formatUtc,
  WEEKDAY_LABELS,
} from "../../../src/presentation/schedule-labels.ts";
import { requireSteppedUp } from "../../account/gate.ts";
import {
  BlackoutForm,
  EndRuleForm,
  InstantForm,
  RemoveBlackoutForm,
  RuleForm,
} from "./forms.tsx";
import { Heartbeat } from "./heartbeat.tsx";

export const metadata: Metadata = {
  title: "Schedule",
  robots: { index: false, follow: false },
};

function ScheduleFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="attorney">
      <Surface emphasis="raised" labelledBy="attorney-schedule-title">
        <Stack>
          <Eyebrow>Attorney workspace</Eyebrow>
          <Heading as="h1" size="lg" id="attorney-schedule-title">
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

function InstantSection({
  instant,
  approved,
}: {
  readonly instant: InstantView | null;
  readonly approved: boolean;
}) {
  return (
    <Stack>
      <Heading as="h2" size="md" id="instant-title">
        Instant mode
      </Heading>
      <Text tone="muted">
        Instant mode lets clients ask for a consultation now. It applies only to
        this signed-in session, only while this page or another page of the
        workspace keeps the session active, and it turns off when you sign out.
        It is always off when you sign in again.
      </Text>
      {instant === null ? (
        <Alert tone="warning" title="Status not available" role="status">
          Instant mode status could not be read for this session. Reload the
          page to try again.
        </Alert>
      ) : (
        <>
          <Status tone={instant.on ? "success" : "neutral"}>
            {instant.on
              ? `On until ${formatUtc(instant.expiresAt ?? "")} (server deadline)`
              : "Off"}
          </Status>
          {instant.otherSessionsOn > 0 ? (
            <Text tone="muted">
              Instant mode is also on in {instant.otherSessionsOn} other
              signed-in session(s). Turning it off here turns it off there too.
            </Text>
          ) : null}
          {!instant.configured ? (
            <Alert tone="information" title="Not configured yet" role="status">
              Instant mode has not been configured for the platform yet, so it
              cannot be turned on.
            </Alert>
          ) : null}
          {!approved && !instant.on ? (
            <Text tone="muted">
              Instant mode can be turned on once your attorney profile is
              approved.
            </Text>
          ) : null}
          <InstantForm on={instant.on} />
        </>
      )}
      <Heartbeat />
    </Stack>
  );
}

function entryWhen(entry: CalendarEntry, displayZone: string): string {
  const zone = entry.timezone ?? displayZone;
  return `${formatInZone(entry.startsAt, zone)} to ${formatInZone(entry.endsAt, zone)}`;
}

export default async function AttorneySchedulePage() {
  // The schedule belongs to each request on the server; never prerender it.
  await connection();
  await requireSteppedUp("attorney");
  const view = await resolveAttorneySchedule(ATTORNEY_SCHEDULE_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <ScheduleFrame title="Sign in to continue">
        <Text tone="muted">
          The schedule is available only to a signed-in account with attorney
          access.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </ScheduleFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <ScheduleFrame title="Schedule not available">
        <Alert tone="warning" title="No schedule access" role="status">
          This account does not have access to an attorney schedule.
        </Alert>
        <Cluster>
          <ButtonLink variant="tertiary" href="/">
            Return to the home page
          </ButtonLink>
        </Cluster>
      </ScheduleFrame>
    );
  }
  if (view.status !== "ready") {
    return (
      <ScheduleFrame title="Schedule unavailable">
        <Alert
          tone="error"
          title="The schedule could not be opened"
          role="alert"
        >
          Your schedule could not be read right now. Please try again later.
        </Alert>
        <Cluster>
          <ButtonLink variant="tertiary" href="/attorney">
            Attorney workspace
          </ButtonLink>
        </Cluster>
      </ScheduleFrame>
    );
  }
  const zones = knownTimeZones();
  const removable = view.blackouts;
  return (
    <ScheduleFrame title="Schedule">
      <Text tone="muted">
        Times are stored by the platform in UTC and shown here in the time zone
        each entry belongs to. Requests can be held only for times inside your
        availability and outside your blackouts.
      </Text>
      <InstantSection
        instant={view.instant}
        approved={view.stage === "approved"}
      />
      <Stack>
        <Heading as="h2" size="md" id="calendar-title">
          Next 14 days
        </Heading>
        {view.calendar.length === 0 ? (
          <Text tone="muted">Nothing is scheduled in the next 14 days.</Text>
        ) : (
          <Table id="attorney-schedule-calendar" caption="Calendar">
            <thead>
              <tr>
                <th scope="col">Entry</th>
                <th scope="col">When</th>
                <th scope="col">UTC</th>
              </tr>
            </thead>
            <tbody>
              {view.calendar.map((entry) => (
                <tr key={`${entry.kind}-${entry.id}-${entry.startsAt}`}>
                  <th scope="row">{ENTRY_LABELS[entry.kind]}</th>
                  <td>{entryWhen(entry, view.displayZone)}</td>
                  <td>
                    {formatUtc(entry.startsAt)} to {formatUtc(entry.endsAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Stack>
      <Stack>
        <Heading as="h2" size="md" id="rules-title">
          Availability
        </Heading>
        {view.rules.length === 0 ? (
          <Text tone="muted">You have not added any availability yet.</Text>
        ) : (
          <Table id="attorney-schedule-rules" caption="Your availability">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Time</th>
                <th scope="col">Time zone</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {view.rules.map((rule) => (
                <tr key={rule.id}>
                  <th scope="row">
                    {rule.kind === "recurring"
                      ? `Every ${WEEKDAY_LABELS[rule.weekday ?? 0]} from ${rule.effectiveFrom}${
                          rule.effectiveUntil === null
                            ? ""
                            : ` until ${rule.effectiveUntil}`
                        }`
                      : `On ${rule.date}`}
                  </th>
                  <td>
                    {rule.startTime} to {rule.endTime}
                  </td>
                  <td>{rule.timezone}</td>
                  <td>
                    <EndRuleForm ruleId={rule.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Heading as="h3" size="sm" id="rule-form-title">
          Add availability
        </Heading>
        <RuleForm zones={zones} defaultZone={view.displayZone} />
      </Stack>
      <Stack>
        <Heading as="h2" size="md" id="blackouts-title">
          Blackouts
        </Heading>
        {removable.length === 0 ? (
          <Text tone="muted">You have no current or upcoming blackouts.</Text>
        ) : (
          <Table id="attorney-schedule-blackouts" caption="Your blackouts">
            <thead>
              <tr>
                <th scope="col">From</th>
                <th scope="col">Until</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {removable.map((blackout) => (
                <tr key={blackout.id}>
                  <td>{formatInZone(blackout.startsAt, view.displayZone)}</td>
                  <td>{formatInZone(blackout.endsAt, view.displayZone)}</td>
                  <td>
                    {blackout.removable ? (
                      <RemoveBlackoutForm blackoutId={blackout.id} />
                    ) : (
                      <Text tone="muted">Started</Text>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Heading as="h3" size="sm" id="blackout-form-title">
          Add a blackout
        </Heading>
        <BlackoutForm zones={zones} defaultZone={view.displayZone} />
      </Stack>
      <Cluster>
        <ButtonLink variant="tertiary" href="/attorney">
          Attorney workspace
        </ButtonLink>
      </Cluster>
    </ScheduleFrame>
  );
}
