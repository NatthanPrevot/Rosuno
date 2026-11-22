// Data requests: one request (MVP-001 S11; PS-A6 section 3).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs the global manage_data_requests grant (the
// database decides; an unknown and a malformed id get the same not-found
// page). The page shows the request's type, state, the client's own
// description, its times, its assignment, the requester's User identifier
// and account state and whether a Legal Hold applies. Staff assign the
// request to themselves and record a decision; a decision is a record only
// and changes no data, and the database refuses a deletion recorded as
// allowed while a Legal Hold applies.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { resolveDataRequest } from "../../../../src/application/data-requests.ts";
import { STAFF_DATA_REQUEST_SOURCES } from "../../../../src/infrastructure/privacy/privacy-adapter.ts";
import { utcText } from "../../../../src/presentation/completion-labels.ts";
import {
  Cluster,
  Heading,
  Status,
  Table,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import {
  ACCOUNT_STATE_LABELS,
  DATA_REQUEST_STAFF_NOTE,
  OUTCOME_LABELS,
  REQUEST_STATE_LABELS,
  STAFF_REQUEST_TYPE_LABELS,
} from "../../../../src/presentation/privacy-labels.ts";
import { requireSteppedUp } from "../../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../../frame.tsx";
import { AssignRequestForm, DecideRequestForm } from "../forms.tsx";

export const metadata: Metadata = {
  title: "Data request",
  robots: { index: false, follow: false },
};

export default async function DataRequestPage({
  params,
}: {
  readonly params: Promise<{ readonly request: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { request: requestId } = await params;
  const view = await resolveDataRequest(STAFF_DATA_REQUEST_SOURCES, requestId);
  if (view.status === "not-found") {
    notFound();
  }
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/data-requests/[request]", "Data requests");
  }
  const request = view.request;
  const rows: [string, string][] = [
    ["Kind of request", STAFF_REQUEST_TYPE_LABELS[request.type]],
    ["Submitted", utcText(request.submittedAt)],
    ["Description", request.details ?? "No description given"],
    [
      "Assigned",
      request.assignedToMe ? "To you" : request.assigned ? "Yes" : "No",
    ],
    ["Requester (User identifier)", request.requesterUserId],
    ["Requester account", ACCOUNT_STATE_LABELS[request.requesterAccountState]],
    ["Legal Hold applies", request.legalHoldApplies ? "Yes" : "No"],
    ...(request.outcome === null || request.decidedAt === null
      ? []
      : ([
          ["Decision", OUTCOME_LABELS[request.outcome]],
          ["Decided", utcText(request.decidedAt)],
        ] as [string, string][])),
    ["Last changed", utcText(request.updatedAt)],
  ];
  return (
    <StaffFrame eyebrow="Clients" title="Data request">
      <BackLink href="/staff/data-requests">Data requests</BackLink>
      <Cluster>
        <Status tone={REQUEST_STATE_LABELS[request.state].tone}>
          {REQUEST_STATE_LABELS[request.state].label}
        </Status>
      </Cluster>
      <Table id="data-request" caption="Request">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Heading as="h2" size="md" id="request-steps-title">
        Handling
      </Heading>
      <Text tone="muted">{DATA_REQUEST_STAFF_NOTE}</Text>
      <AssignRequestForm
        request={request.id}
        label={
          request.state === "submitted"
            ? "Assign to me"
            : request.state === "in_review" && !request.assignedToMe
              ? "Take over"
              : null
        }
      />
      <DecideRequestForm
        request={request.id}
        open={request.state === "in_review"}
      />
      {request.state === "decided" || request.state === "withdrawn" ? (
        <Text>This request is closed.</Text>
      ) : null}
    </StaffFrame>
  );
}
