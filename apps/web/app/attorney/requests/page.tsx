// The attorney's request queue (MVP-001 S8; MBS section 13 "attorney request
// queue").
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the trusted session and the trusted
// attorney principal source decide access through the unchanged Security
// Shell, and the database answers the attorney's own Requests waiting for a
// decision (aal2, an approved profile): the consultation asked for, how soon,
// the held time, the attorney-side price and platform fee with their
// currency, and the latest time to decide, every instant in UTC. A Request
// the server reports past its deadline is shown expired. Nothing of the
// client, their message or their Intake is shown (Packet section 3: counsel
// gate). The page reads no route parameter, query, header, or cookie of its
// own.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  attorneyRequestPathFor,
  resolveAttorneyQueue,
} from "../../../src/application/attorney-requests.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { ATTORNEY_REQUEST_SOURCES } from "../../../src/infrastructure/requests/attorney-request-adapter.ts";
import {
  ATTORNEY_REQUEST_PATH_LABELS,
  DECIDE_BY_NOTE,
  durationText,
  modalityText,
  moneyText,
  NO_REQUESTS,
  QUEUE_INTRO,
  utcText,
} from "../../../src/presentation/attorney-request-labels.ts";
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
  title: "Requests",
  robots: { index: false, follow: false },
};

function RequestsFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="attorney">
      <Surface emphasis="raised" labelledBy="attorney-requests-title">
        <Stack>
          <Eyebrow>Attorney workspace</Eyebrow>
          <Heading as="h1" size="lg" id="attorney-requests-title">
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

const WORKSPACE = (
  <Cluster>
    <ButtonLink variant="tertiary" href="/attorney">
      Attorney workspace
    </ButtonLink>
  </Cluster>
);

export default async function AttorneyRequestsPage() {
  // The queue belongs to each request on the server; never prerender it.
  await connection();
  await requireSteppedUp("attorney");
  const view = await resolveAttorneyQueue(ATTORNEY_REQUEST_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <RequestsFrame title="Sign in to continue">
        <Text tone="muted">
          Requests are available only to a signed-in account with attorney
          access.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </RequestsFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <RequestsFrame title="Requests not available">
        <Alert tone="warning" title="No requests access" role="status">
          This account does not have access to attorney requests.
        </Alert>
        <Cluster>
          <ButtonLink variant="tertiary" href="/">
            Return to the home page
          </ButtonLink>
        </Cluster>
      </RequestsFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "attorney_decision.view_unavailable", {
      route: "/attorney/requests",
      outcome: view.status,
    });
    return (
      <RequestsFrame title="Requests unavailable">
        <Alert
          tone="error"
          title="Your requests could not be opened"
          role="alert"
        >
          Your requests could not be read right now. Please try again later.
        </Alert>
        {WORKSPACE}
      </RequestsFrame>
    );
  }
  return (
    <RequestsFrame title="Requests">
      <Text tone="muted">{QUEUE_INTRO}</Text>
      {view.entries.length === 0 ? (
        <Text tone="muted">{NO_REQUESTS}</Text>
      ) : (
        <Table id="attorney-request-queue" caption="Requests waiting for you">
          <thead>
            <tr>
              <th scope="col">Consultation</th>
              <th scope="col">How soon</th>
              <th scope="col">Time</th>
              <th scope="col">Your price</th>
              <th scope="col">Decide by</th>
              <th scope="col">Request</th>
            </tr>
          </thead>
          <tbody>
            {view.entries.map((entry) => (
              <tr key={entry.id}>
                <th scope="row">
                  {`${modalityText(entry.modality)}, ${durationText(entry.durationMinutes)}`}
                </th>
                <td>{ATTORNEY_REQUEST_PATH_LABELS[entry.path]}</td>
                <td>
                  {entry.slotStart === null || entry.slotEnd === null
                    ? "Now"
                    : `${utcText(entry.slotStart)} to ${utcText(entry.slotEnd)}`}
                </td>
                <td>{moneyText(entry.listedPriceMinor, entry.currency)}</td>
                <td>
                  {entry.expiredDue ? (
                    <Status tone="warning">Expired</Status>
                  ) : entry.decideBy === null ? (
                    "Not shown"
                  ) : (
                    utcText(entry.decideBy)
                  )}
                </td>
                <td>
                  <ButtonLink
                    variant="tertiary"
                    href={attorneyRequestPathFor(entry.id)}
                  >
                    Open request
                  </ButtonLink>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Text tone="muted">{DECIDE_BY_NOTE}</Text>
      {WORKSPACE}
    </RequestsFrame>
  );
}
