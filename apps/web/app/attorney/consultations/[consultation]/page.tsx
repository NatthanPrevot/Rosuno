// One of the attorney's Consultations: the consultation room, the start and
// the end (MVP-001 S9; MBS section 14 "attorney consultation workspace"; IMP
// section 25; TA sections 46 and 48; DM section 2.4; PM row 20).
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell. The route segment only names which of the attorney's own
// Consultations to show; another attorney's, an unknown and a malformed id
// get the same not-found page. The page shows the state the server reports
// (ready as soon as the server reports the window open, even before the
// transition is recorded: the browser never decides it), when the room opens
// and closes (UTC), the start and end and the attendance the room recorded.
// While the Consultation is ready inside its window, the start form (the room
// is not granted before the start, so a refused start never opens it); once
// it is live and the window open, the join form and the end form (the
// attorney's declaration of normal completion). The
// database decides again on every submission. Nothing of the client's
// identity is shown.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveAttorneyConsultation } from "../../../../src/application/consultations.ts";
import { ATTORNEY_CONSULTATION_SOURCES } from "../../../../src/infrastructure/consultations/consultation-adapter.ts";
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
import {
  ATTORNEY_READY_NOTE,
  ATTORNEY_STATE_LABELS,
  COMPLETION_LABELS,
  durationText,
  ENDED_NOTE,
  EVIDENCE_NOTE,
  MEDIA_STATE_LABELS,
  modalityText,
  NOT_OPEN_NOTE,
  PATH_LABELS,
  utcText,
  WINDOW_PASSED_NOTE,
  WORKSPACE_NOTE,
} from "../../../../src/presentation/consultation-labels.ts";
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
import { requireSteppedUp } from "../../../account/gate.ts";
import { CommandPanel, RoomPanel } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Consultation",
  robots: { index: false, follow: false },
};

function ConsultationFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="attorney">
      <Surface emphasis="raised" labelledBy="attorney-consultation-title">
        <Stack>
          <Eyebrow>Attorney workspace</Eyebrow>
          <Heading as="h1" size="lg" id="attorney-consultation-title">
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

const BACK = (
  <Cluster>
    <ButtonLink variant="tertiary" href="/attorney/consultations">
      All consultations
    </ButtonLink>
  </Cluster>
);

export default async function AttorneyConsultationPage({
  params,
}: {
  readonly params: Promise<{ readonly consultation: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const { consultation } = await params;
  const view = await resolveAttorneyConsultation(
    ATTORNEY_CONSULTATION_SOURCES,
    consultation,
  );
  if (view.status === "not-found") {
    notFound();
  }
  if (view.status === "sign-in-required") {
    return (
      <ConsultationFrame title="Sign in to continue">
        <Text tone="muted">
          Consultations are available only to a signed-in account with attorney
          access.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </ConsultationFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <ConsultationFrame title="Consultation not available">
        <Alert tone="warning" title="No consultations access" role="status">
          This account does not have access to attorney consultations.
        </Alert>
      </ConsultationFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "consultation.view_unavailable", {
      route: "/attorney/consultations/[consultation]",
      outcome: view.status,
    });
    return (
      <ConsultationFrame title="Consultation unavailable">
        <Alert tone="error" title="Something went wrong" role="alert">
          This consultation could not be shown right now. Please try again
          later.
        </Alert>
        {BACK}
      </ConsultationFrame>
    );
  }
  const record = view.consultation;
  const state = ATTORNEY_STATE_LABELS[view.displayState];
  const ended = [
    "completed",
    "cancelled",
    "no_show",
    "technical_failure",
  ].includes(record.state);
  return (
    <ConsultationFrame title="Consultation">
      <Cluster>
        <Status tone={state.tone}>{state.label}</Status>
      </Cluster>
      <Text tone="muted">{WORKSPACE_NOTE}</Text>
      {ended ? <Text>{ENDED_NOTE}</Text> : null}
      {view.startable ? <Text>{ATTORNEY_READY_NOTE}</Text> : null}
      {!ended && !view.joinable && !view.waiting ? (
        <Text>{view.windowPassed ? WINDOW_PASSED_NOTE : NOT_OPEN_NOTE}</Text>
      ) : null}
      <Table id="attorney-consultation-details" caption="Consultation details">
        <tbody>
          <tr>
            <th scope="row">Consultation</th>
            <td>
              {record.durationMinutes === null
                ? modalityText(record.modality)
                : `${modalityText(record.modality)}, ${durationText(record.durationMinutes)}`}
            </td>
          </tr>
          <tr>
            <th scope="row">How soon</th>
            <td>{PATH_LABELS[record.path]}</td>
          </tr>
          {record.bookingStart === null || record.bookingEnd === null ? null : (
            <tr>
              <th scope="row">Time</th>
              <td>{`${utcText(record.bookingStart)} to ${utcText(record.bookingEnd)}`}</td>
            </tr>
          )}
          {record.opensAt === null || record.closesAt === null ? null : (
            <tr>
              <th scope="row">Room open</th>
              <td>{`${utcText(record.opensAt)} to ${utcText(record.closesAt)}`}</td>
            </tr>
          )}
          {record.startedAt === null ? null : (
            <tr>
              <th scope="row">Started</th>
              <td>{utcText(record.startedAt)}</td>
            </tr>
          )}
          {record.endedAt === null ? null : (
            <tr>
              <th scope="row">Ended</th>
              <td>{utcText(record.endedAt)}</td>
            </tr>
          )}
          {record.outcomeCode === null ? null : (
            <tr>
              <th scope="row">How it ended</th>
              <td>{COMPLETION_LABELS[record.outcomeCode] ?? "Ended"}</td>
            </tr>
          )}
          {record.mediaState === null ? null : (
            <tr>
              <th scope="row">Consultation room</th>
              <td>{MEDIA_STATE_LABELS[record.mediaState]}</td>
            </tr>
          )}
        </tbody>
      </Table>
      <RoomPanel consultationId={record.id} joinable={view.joinable} />
      <CommandPanel
        consultationId={record.id}
        startable={view.startable}
        endable={view.endable}
      />
      <Table
        id="attorney-consultation-attendance"
        caption="Attendance recorded"
      >
        <tbody>
          <tr>
            <th scope="row">You joined</th>
            <td>
              {record.attorneyJoinedAt === null
                ? "Not yet"
                : utcText(record.attorneyJoinedAt)}
            </td>
          </tr>
          <tr>
            <th scope="row">The client joined</th>
            <td>
              {record.clientJoinedAt === null
                ? "Not yet"
                : utcText(record.clientJoinedAt)}
            </td>
          </tr>
          <tr>
            <th scope="row">Both present together</th>
            <td>{record.bothPresent ? "Yes" : "No"}</td>
          </tr>
          <tr>
            <th scope="row">Reconnections</th>
            <td>{String(record.reconnections)}</td>
          </tr>
        </tbody>
      </Table>
      <Text tone="muted">{EVIDENCE_NOTE}</Text>
      {BACK}
    </ConsultationFrame>
  );
}
