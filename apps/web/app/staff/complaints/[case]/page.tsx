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
// facts, the latest payment state, the Legal Holds in force on the case or
// its Consultation and the complainant's own statement (PS-A6 section 5).
// Staff assign, unassign, escalate or return the case; classification and
// resolution offer exactly the codes of the complaint vocabulary the
// database selects for the case (PS-A6 section 4; while none is configured
// the page says so and the database would change nothing). Holders of the
// global Legal Holds grant can place a hold on the case from here.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, the Support complaint
// record): the design's record panel with the state pill, the case, the
// consultation facts, what was reported, then the handling forms and the
// Legal Hold form.

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
  Block,
  KeyValues,
  Note,
  RecordPanel,
} from "../../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../../account/gate.ts";
import { refusalPage } from "../../frame.tsx";
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
  const caseRows: [string, string][] = [
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
    ["Legal Holds in force", String(record.activeLegalHolds)],
  ];
  const consultationRows: [string, string][] = [
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
  ];
  const holds = await legalHoldsHeld(LEGAL_HOLD_SOURCES);
  return (
    <RecordPanel
      titleId="staff-configuration-title"
      title="Reported problem"
      sub={`Reported ${utcText(record.openedAt)} · times in UTC`}
      pill={{
        tone: COMPLAINT_STATE_LABELS[record.state].tone,
        label: COMPLAINT_STATE_LABELS[record.state].label,
      }}
      back={{ href: "/staff/complaints", label: "Reported problems" }}
    >
      <Block title="Case">
        <KeyValues items={caseRows} />
      </Block>
      <Block title="What was reported">
        <Note>{record.statement ?? "No description given"}</Note>
      </Block>
      <Block title="Consultation">
        <KeyValues items={consultationRows} />
        {record.consultationId === null ? null : (
          <div className="st-links">
            <a
              className="btn btn-line btn-sm"
              href={`/staff/consultations/${record.consultationId}`}
            >
              Open the consultation (needs consultation operations)
            </a>
          </div>
        )}
      </Block>
      <Block title="Handling">
        {record.state === "resolved" ? null : (
          <>
            <CaseActionsForm
              caseId={record.id}
              actions={actionsOf(record.state, record.assignedToMe)}
            />
            <DecideCaseForm
              caseId={record.id}
              kind="classify"
              codes={record.categoryCodes}
            />
          </>
        )}
        {/* One slot for the resolution form, so it (and the message for the
            state its action returned) stays mounted when the case is resolved. */}
        <DecideCaseForm
          caseId={record.id}
          kind="resolve"
          codes={record.resolutionCodes}
          resolved={record.state === "resolved"}
        />
      </Block>
      {holds ? (
        <Block title="Legal Hold">
          <PlaceHoldForm scope={{ type: "complaint_case", id: record.id }} />
        </Block>
      ) : null}
    </RecordPanel>
  );
}
