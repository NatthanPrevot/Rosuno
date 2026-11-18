// One Request offered to the attorney, and the decision on it (MVP-001 S8;
// MBS section 13 "accept/decline action" and "attorney-facing
// request/acceptance UI"; DM section 9).
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell. The route segment only names which of the attorney's own Requests to
// show; another attorney's, an unknown and a malformed id get the same
// not-found page. The page shows the state the database reports (expired as
// soon as the server reports a deadline passed, even before the expiry is
// recorded: the browser never decides it), the consultation asked for, how
// soon, the held time, the attorney-side price and platform fee, the server
// deadlines in UTC and, after acceptance, the consultation's state and time
// (MVP-001 S9: with one link to the consultation's own page, which decides
// its own access).
// While the Request awaits the attorney and is not past its deadline, the
// accept and decline forms are offered; the database decides again, with
// fresh evaluations, at the moment of the decision. Nothing of the client,
// their message or their Intake is shown (Packet section 3: counsel gate).

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveAttorneyRequest } from "../../../../src/application/attorney-requests.ts";
import { attorneyConsultationPathFor } from "../../../../src/application/consultations.ts";
import { logRequestEvent } from "../../../../src/infrastructure/observability/request-log.ts";
import { ATTORNEY_REQUEST_SOURCES } from "../../../../src/infrastructure/requests/attorney-request-adapter.ts";
import {
  ACCEPTED_NOTE,
  ATTORNEY_REQUEST_PATH_LABELS,
  ATTORNEY_REQUEST_STATE_LABELS,
  CONSULTATION_PENDING_NOTE,
  CONSULTATION_STATE_LABELS,
  DECIDE_BY_NOTE,
  DETAIL_NOTE,
  durationText,
  EXPIRED_REQUEST_NOTE,
  modalityText,
  moneyText,
  utcText,
} from "../../../../src/presentation/attorney-request-labels.ts";
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
import { DecisionPanel } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Request",
  robots: { index: false, follow: false },
};

function RequestFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="attorney">
      <Surface emphasis="raised" labelledBy="attorney-request-title">
        <Stack>
          <Eyebrow>Attorney workspace</Eyebrow>
          <Heading as="h1" size="lg" id="attorney-request-title">
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
    <ButtonLink variant="tertiary" href="/attorney/requests">
      All requests
    </ButtonLink>
  </Cluster>
);

export default async function AttorneyRequestPage({
  params,
}: {
  readonly params: Promise<{ readonly request: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const { request } = await params;
  const view = await resolveAttorneyRequest(ATTORNEY_REQUEST_SOURCES, request);
  if (view.status === "not-found") {
    notFound();
  }
  if (view.status === "sign-in-required") {
    return (
      <RequestFrame title="Sign in to continue">
        <Text tone="muted">
          Requests are available only to a signed-in account with attorney
          access.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </RequestFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <RequestFrame title="Request not available">
        <Alert tone="warning" title="No requests access" role="status">
          This account does not have access to attorney requests.
        </Alert>
      </RequestFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "attorney_decision.view_unavailable", {
      route: "/attorney/requests/[request]",
      outcome: view.status,
    });
    return (
      <RequestFrame title="Request unavailable">
        <Alert tone="error" title="Something went wrong" role="alert">
          This request could not be shown right now. Please try again later.
        </Alert>
        {BACK}
      </RequestFrame>
    );
  }
  const record = view.request;
  const state = ATTORNEY_REQUEST_STATE_LABELS[view.displayState];
  return (
    <RequestFrame title="Request">
      <Cluster>
        <Status tone={state.tone}>{state.label}</Status>
      </Cluster>
      <Text tone="muted">{DETAIL_NOTE}</Text>
      {view.displayState === "expired" ? (
        <Text>{EXPIRED_REQUEST_NOTE}</Text>
      ) : null}
      <Table id="attorney-request-details" caption="Request details">
        <tbody>
          <tr>
            <th scope="row">Consultation</th>
            <td>{`${modalityText(record.modality)}, ${durationText(record.durationMinutes)}`}</td>
          </tr>
          <tr>
            <th scope="row">How soon</th>
            <td>{ATTORNEY_REQUEST_PATH_LABELS[record.path]}</td>
          </tr>
          {record.slotStart === null || record.slotEnd === null ? null : (
            <tr>
              <th scope="row">Time</th>
              <td>{`${utcText(record.slotStart)} to ${utcText(record.slotEnd)}`}</td>
            </tr>
          )}
          <tr>
            <th scope="row">Your price</th>
            <td>{moneyText(record.listedPriceMinor, record.currency)}</td>
          </tr>
          <tr>
            <th scope="row">Platform fee</th>
            <td>{moneyText(record.platformFeeMinor, record.currency)}</td>
          </tr>
          <tr>
            <th scope="row">Requested</th>
            <td>{utcText(record.createdAt)}</td>
          </tr>
          {record.decideBy === null ? null : (
            <tr>
              <th scope="row">Decide by</th>
              <td>{utcText(record.decideBy)}</td>
            </tr>
          )}
          {record.decidedAt === null ? null : (
            <tr>
              <th scope="row">Decided</th>
              <td>{utcText(record.decidedAt)}</td>
            </tr>
          )}
        </tbody>
      </Table>
      {record.state === "accepted" ? (
        record.consultationState === null ? (
          <Text>{CONSULTATION_PENDING_NOTE}</Text>
        ) : (
          <Stack gap="tight">
            <Text>{ACCEPTED_NOTE}</Text>
            <Table id="attorney-request-consultation" caption="Consultation">
              <tbody>
                <tr>
                  <th scope="row">Status</th>
                  <td>{CONSULTATION_STATE_LABELS[record.consultationState]}</td>
                </tr>
                {record.bookingStart === null ||
                record.bookingEnd === null ? null : (
                  <tr>
                    <th scope="row">Time</th>
                    <td>{`${utcText(record.bookingStart)} to ${utcText(record.bookingEnd)}`}</td>
                  </tr>
                )}
              </tbody>
            </Table>
            {record.consultationId === null ? null : (
              <Cluster>
                <ButtonLink
                  variant="secondary"
                  href={attorneyConsultationPathFor(record.consultationId)}
                >
                  Open the consultation
                </ButtonLink>
              </Cluster>
            )}
          </Stack>
        )
      ) : null}
      <DecisionPanel requestId={record.id} decidable={view.decidable} />
      <Text tone="muted">{DECIDE_BY_NOTE}</Text>
      {BACK}
    </RequestFrame>
  );
}
