// The client's reported problems (MVP-001 S11; MBS section 16 "Complaint
// foundation"; PS section 27.1; PM row 47).
//
// Rendered on the server for every request and never indexed. The verified
// client of the request decides access; the database answers only the
// client's own Complaint Cases (state, linkage and instants; nothing about
// assignment, classification or resolution). The report form may name one of
// the client's own Consultations; the one query value read only preselects
// it, and the database checks it again on submission.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveClientComplaints } from "../../../src/application/complaints.ts";
import { resolveClientConsultations } from "../../../src/application/consultation-outcomes.ts";
import { isUuid } from "../../../src/application/professional-records.ts";
import {
  CLIENT_COMPLAINT_SOURCES,
  CLIENT_OUTCOME_SOURCES,
} from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import {
  COMPLAINT_NOTE,
  COMPLAINT_STATE_LABELS,
  utcText,
} from "../../../src/presentation/completion-labels.ts";
import {
  CLIENT_STATE_LABELS,
  modalityText,
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
import { ReportForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Report a problem",
  robots: { index: false, follow: false },
};

function Frame({ children }: { readonly children: ReactNode }) {
  return (
    <Page density="client">
      <Surface emphasis="raised" labelledBy="complaints-title">
        <Stack>
          <Eyebrow>Client workspace</Eyebrow>
          <Heading as="h1" size="lg" id="complaints-title">
            Report a problem
          </Heading>
          {children}
          <Cluster>
            <ButtonLink variant="tertiary" href="/client">
              Back to your workspace
            </ButtonLink>
          </Cluster>
        </Stack>
      </Surface>
    </Page>
  );
}

export default async function ClientComplaintsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly consultation?: string | string[];
  }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const { consultation } = await searchParams;
  const view = await resolveClientComplaints(CLIENT_COMPLAINT_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <Frame>
        <Text tone="muted">Sign in to report a problem.</Text>
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
          This account cannot report problems here.
        </Alert>
      </Frame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "complaint.view_unavailable", {
      route: "/client/complaints",
      outcome: view.status,
    });
    return (
      <Frame>
        <Alert tone="error" title="Something went wrong" role="alert">
          Your reports could not be shown right now. Please try again later.
        </Alert>
      </Frame>
    );
  }
  const list = await resolveClientConsultations(CLIENT_OUTCOME_SOURCES);
  const consultations =
    list.status === "ready"
      ? list.entries.map((entry) => ({
          id: entry.id,
          label: `${modalityText(entry.modality)}, ${CLIENT_STATE_LABELS[entry.state].label}${
            entry.bookingStart === null
              ? ""
              : `, ${utcText(entry.bookingStart)}`
          }`,
        }))
      : [];
  const selected =
    typeof consultation === "string" &&
    isUuid(consultation) &&
    consultations.some((entry) => entry.id === consultation)
      ? consultation
      : null;
  return (
    <Frame>
      <Text tone="muted">{COMPLAINT_NOTE}</Text>
      <ReportForm consultations={consultations} selected={selected} />
      <Heading as="h2" size="md" id="reports-title">
        Your reports
      </Heading>
      {view.cases.length === 0 ? (
        <Text>You have not reported a problem.</Text>
      ) : (
        view.cases.map((entry) => (
          <Surface key={entry.id} labelledBy={`report-${entry.id}`}>
            <Stack gap="tight">
              <Heading as="h3" size="sm" id={`report-${entry.id}`}>
                {`Reported ${utcText(entry.openedAt)}`}
              </Heading>
              <Cluster>
                <Status tone={COMPLAINT_STATE_LABELS[entry.state].tone}>
                  {COMPLAINT_STATE_LABELS[entry.state].label}
                </Status>
              </Cluster>
              {entry.consultationId === null ? null : (
                <Cluster>
                  <ButtonLink
                    variant="tertiary"
                    href={`/client/consultations/${entry.consultationId}`}
                  >
                    Open the consultation
                  </ButtonLink>
                </Cluster>
              )}
              {entry.resolvedAt === null ? null : (
                <Text size="small">{`Resolved ${utcText(entry.resolvedAt)}`}</Text>
              )}
            </Stack>
          </Surface>
        ))
      )}
    </Frame>
  );
}
