// The attorney's consultations (MVP-001 S9; MBS section 14 "attorney
// consultation workspace"; DM section 2.4).
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell. The page lists the attorney's own scheduled, ready and live
// Consultations, live first, with the state and the times the server reports
// (ready as soon as the server reports the window open: the browser never
// decides it), each linking to its own page. Nothing of the client's identity
// is shown.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  attorneyConsultationPathFor,
  displayStateOf,
  resolveAttorneyConsultations,
} from "../../../src/application/consultations.ts";
import { ATTORNEY_CONSULTATION_SOURCES } from "../../../src/infrastructure/consultations/consultation-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import {
  ATTORNEY_STATE_LABELS,
  durationText,
  LIST_INTRO,
  modalityText,
  NO_CONSULTATIONS,
  PATH_LABELS,
  utcText,
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
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { requireSteppedUp } from "../../account/gate.ts";

export const metadata: Metadata = {
  title: "Consultations",
  robots: { index: false, follow: false },
};

function ListFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="attorney">
      <Surface emphasis="raised" labelledBy="attorney-consultations-title">
        <Stack>
          <Eyebrow>Attorney workspace</Eyebrow>
          <Heading as="h1" size="lg" id="attorney-consultations-title">
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
    <ButtonLink variant="tertiary" href="/attorney">
      Back to your workspace
    </ButtonLink>
  </Cluster>
);

export default async function AttorneyConsultationsPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const view = await resolveAttorneyConsultations(
    ATTORNEY_CONSULTATION_SOURCES,
  );
  if (view.status === "sign-in-required") {
    return (
      <ListFrame title="Sign in to continue">
        <Text tone="muted">
          Consultations are available only to a signed-in account with attorney
          access.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </ListFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <ListFrame title="Consultations not available">
        <Alert tone="warning" title="No consultations access" role="status">
          This account does not have access to attorney consultations.
        </Alert>
      </ListFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "consultation.view_unavailable", {
      route: "/attorney/consultations",
      outcome: view.status,
    });
    return (
      <ListFrame title="Consultations unavailable">
        <Alert tone="error" title="Something went wrong" role="alert">
          Your consultations could not be shown right now. Please try again
          later.
        </Alert>
        {BACK}
      </ListFrame>
    );
  }
  return (
    <ListFrame title="Consultations">
      <Text tone="muted">{LIST_INTRO}</Text>
      {view.entries.length === 0 ? (
        <Text>{NO_CONSULTATIONS}</Text>
      ) : (
        <Table id="attorney-consultations" caption="Your consultations">
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Consultation</th>
              <th scope="col">How soon</th>
              <th scope="col">Time</th>
              <th scope="col">Open</th>
            </tr>
          </thead>
          <tbody>
            {view.entries.map((entry) => {
              const state = ATTORNEY_STATE_LABELS[displayStateOf(entry)];
              return (
                <tr key={entry.id}>
                  <td>
                    <Status tone={state.tone}>{state.label}</Status>
                  </td>
                  <td>
                    {entry.durationMinutes === null
                      ? modalityText(entry.modality)
                      : `${modalityText(entry.modality)}, ${durationText(entry.durationMinutes)}`}
                  </td>
                  <td>{PATH_LABELS[entry.path]}</td>
                  <td>
                    {entry.bookingStart === null
                      ? entry.startedAt === null
                        ? "Not started"
                        : utcText(entry.startedAt)
                      : utcText(entry.bookingStart)}
                  </td>
                  <td>
                    <ButtonLink
                      variant="secondary"
                      href={attorneyConsultationPathFor(entry.id)}
                    >
                      Open
                    </ButtonLink>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {BACK}
    </ListFrame>
  );
}
