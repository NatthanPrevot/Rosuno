// Reported problems: one case (MVP-001 S11; MBS section 16 "Complaint
// foundation"; PS sections 26.2, 27.1 and 30.4; TA sections 40 and 41; PM
// rows 47 and 48).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs manage_complaints for the case's jurisdiction
// (the database decides; another jurisdiction's, an unknown and a malformed
// id get the same not-found page). The page shows the minimum metadata the
// database answers: the state, who reported it (client or attorney, never a
// name), the linked Consultation's and Referral's states, four attendance
// facts, the latest payment state and the Legal Holds in force on the case or
// its Consultation. Staff assign, unassign, escalate or return the case;
// classification and resolution need the complaint vocabularies, which are
// configuration not adopted yet (the database answers that and changes
// nothing). Holders of the global Legal Holds grant can place a hold on the
// case from here.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import {
  resolveComplaintCase,
  type CaseAction,
  type ComplaintState,
} from "../../../../src/application/complaints.ts";
import { legalHoldsHeld } from "../../../../src/application/legal-holds.ts";
import {
  LEGAL_HOLD_SOURCES,
  STAFF_COMPLAINT_SOURCES,
} from "../../../../src/infrastructure/consultations/completion-adapter.ts";
import {
  COMPLAINT_STATE_LABELS,
  outcomeLabelOf,
  utcText,
} from "../../../../src/presentation/completion-labels.ts";
import {
  ButtonLink,
  Cluster,
  Heading,
  Status,
  Table,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import { requireSteppedUp } from "../../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../../frame.tsx";
import { PlaceHoldForm } from "../../legal-holds/forms.tsx";
import { CaseActionsForm, DecideCaseForm } from "../forms.tsx";

export const metadata: Metadata = {
  title: "Reported problem",
  robots: { index: false, follow: false },
};

const yes = (value: boolean) => (value ? "yes" : "no");

// The steps the case's state admits (the database decides again).
function actionsOf(state: ComplaintState, assignedToMe: boolean): CaseAction[] {
  switch (state) {
    case "opened":
      return ["assign"];
    case "in_review":
      return [assignedToMe ? "unassign" : "assign", "escalate"];
    case "escalated":
      return assignedToMe
        ? ["return_to_review"]
        : ["assign", "return_to_review"];
    default:
      return [];
  }
}

export default async function ComplaintCasePage({
  params,
}: {
  readonly params: Promise<{ readonly case: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { case: caseId } = await params;
  const view = await resolveComplaintCase(STAFF_COMPLAINT_SOURCES, caseId);
  if (view.status === "not-found") {
    notFound();
  }
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/complaints/[case]", "Reported problems");
  }
  const record = view.complaintCase;
  const rows: [string, string][] = [
    [
      "Reported by",
      record.complainantRole === "client" ? "The client" : "The attorney",
    ],
    ["Reported", utcText(record.openedAt)],
    ["Assigned to you", yes(record.assignedToMe)],
    ["Category", record.categoryCode ?? "Not classified"],
    ...(record.resolvedAt === null
      ? []
      : ([
          ["Resolved", utcText(record.resolvedAt)],
          ["Resolution", record.resolutionCode ?? ""],
        ] as [string, string][])),
    [
      "Consultation",
      record.consultationId === null
        ? "Not about a consultation"
        : `${record.consultationState ?? ""}${
            outcomeLabelOf(record.consultationOutcomeCode) === null
              ? ""
              : `: ${outcomeLabelOf(record.consultationOutcomeCode)}`
          }`,
    ],
    ...(record.referralId === null
      ? []
      : ([["Referral outcome", record.referralOutcomeCode ?? "None"]] as [
          string,
          string,
        ][])),
    ["Attorney joined", yes(record.attorneyJoined)],
    ["Client joined", yes(record.clientJoined)],
    ["Both present together", yes(record.bothPresent)],
    ["Either participant left", yes(record.eitherLeft)],
    [
      "Latest payment state",
      record.paymentState === null
        ? "No payment"
        : record.paymentState.replaceAll("_", " "),
    ],
    ["Legal Holds in force", String(record.activeLegalHolds)],
  ];
  const holds = await legalHoldsHeld(LEGAL_HOLD_SOURCES);
  return (
    <StaffFrame eyebrow="Complaints" title="Reported problem">
      <BackLink href="/staff/complaints">Reported problems</BackLink>
      <Cluster>
        <Status tone={COMPLAINT_STATE_LABELS[record.state].tone}>
          {COMPLAINT_STATE_LABELS[record.state].label}
        </Status>
      </Cluster>
      <Table id="complaint-case" caption="Case metadata">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      {record.consultationId === null ? null : (
        <Cluster>
          <ButtonLink
            variant="tertiary"
            href={`/staff/consultations/${record.consultationId}`}
          >
            Open the consultation (needs consultation operations)
          </ButtonLink>
        </Cluster>
      )}
      <Heading as="h2" size="md" id="case-steps-title">
        Handling
      </Heading>
      {record.state === "resolved" ? (
        <Text>This case is resolved.</Text>
      ) : (
        <>
          <CaseActionsForm
            caseId={record.id}
            actions={actionsOf(record.state, record.assignedToMe)}
          />
          <DecideCaseForm caseId={record.id} kind="classify" />
          <DecideCaseForm caseId={record.id} kind="resolve" />
        </>
      )}
      {holds ? (
        <>
          <Heading as="h2" size="md" id="case-hold-title">
            Legal Hold
          </Heading>
          <PlaceHoldForm scope={{ type: "complaint_case", id: record.id }} />
        </>
      ) : null}
    </StaffFrame>
  );
}
