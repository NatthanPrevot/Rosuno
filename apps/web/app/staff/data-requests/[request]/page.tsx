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
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, the privacy request
// record): the design's record panel with the state pill, the request, the
// steps its state has reached (carrying a decision out is never done by the
// platform), the unchanged handling forms, and the internal notes shown as not
// available yet (A33). The response deadline stays the design's policy
// placeholder.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { resolveDataRequest } from "../../../../src/application/data-requests.ts";
import { STAFF_DATA_REQUEST_SOURCES } from "../../../../src/infrastructure/privacy/privacy-adapter.ts";
import { utcText } from "../../../../src/presentation/completion-labels.ts";
import {
  ACCOUNT_STATE_LABELS,
  DATA_REQUEST_STAFF_NOTE,
  OUTCOME_LABELS,
  REQUEST_STATE_LABELS,
  STAFF_REQUEST_TYPE_LABELS,
} from "../../../../src/presentation/privacy-labels.ts";
import {
  Block,
  KeyValues,
  NotAvailableYet,
  RecordPanel,
  Steps,
  type StepState,
} from "../../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../../account/gate.ts";
import { refusalPage } from "../../frame.tsx";
import { AssignRequestForm, DecideRequestForm } from "../forms.tsx";

export const metadata: Metadata = {
  title: "Data request",
  robots: { index: false, follow: false },
};

const CARRIED_OUT = "Not by the platform: a decision is a record only.";

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
  const reviewing: StepState =
    request.state === "submitted" || request.state === "in_review"
      ? "cur"
      : "done";
  const steps =
    request.state === "withdrawn"
      ? [
          {
            label: "Received",
            state: "done" as const,
            note: utcText(request.submittedAt),
          },
          {
            label: "Withdrawn",
            state: "done" as const,
            note: utcText(request.updatedAt),
          },
        ]
      : [
          {
            label: "Received",
            state: "done" as const,
            note: utcText(request.submittedAt),
          },
          {
            label: "In review",
            state: reviewing,
            note: request.assignedToMe
              ? "Assigned to you"
              : request.assigned
                ? "Assigned"
                : "Not assigned yet",
          },
          {
            label: "Decided",
            state: (request.state === "decided" ? "done" : "todo") as StepState,
            note:
              request.outcome === null || request.decidedAt === null
                ? undefined
                : `${OUTCOME_LABELS[request.outcome]} · ${utcText(request.decidedAt)}`,
          },
          {
            label: "Carried out",
            state: "blocked" as const,
            note: CARRIED_OUT,
          },
        ];
  return (
    <RecordPanel
      titleId="staff-configuration-title"
      title={STAFF_REQUEST_TYPE_LABELS[request.type]}
      sub={`Data request · submitted ${utcText(request.submittedAt)}`}
      pill={{
        tone: REQUEST_STATE_LABELS[request.state].tone,
        label: REQUEST_STATE_LABELS[request.state].label,
      }}
      back={{ href: "/staff/data-requests", label: "Data requests" }}
    >
      <Block title="Request">
        <KeyValues
          items={[
            ...rows,
            [
              "Respond by",
              <span key="deadline" className="ph">
                [response deadline — per privacy policy]
              </span>,
            ],
          ]}
        />
      </Block>
      <Block title="Steps">
        <Steps label="Steps" steps={steps} />
      </Block>
      <Block title="Handling">
        <p className="st-emd">{DATA_REQUEST_STAFF_NOTE}</p>
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
          <p className="st-note">This request is closed.</p>
        ) : null}
      </Block>
      <Block title="Internal notes · never shown to the person">
        <NotAvailableYet reason="internal notes on a request wait for a decision on who may write and read them." />
      </Block>
    </RecordPanel>
  );
}
