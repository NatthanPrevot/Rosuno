// The attorney's reported problems (MVP-001 S11; MBS section 16 "Complaint
// foundation"; PS section 27.1; PM row 47).
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (aal2); the unchanged Security Shell then decides access
// and the database answers only the attorney's own Complaint Cases (state,
// linkage, instants and, PS-A6 section 5, the attorney's own statement; never
// another participant's). The report form may name one of the attorney's own
// current Consultations, or the Consultation the attorney came from (the one
// query value read, only to preselect it); the database checks it again on
// submission.
//
// DEV-001: the owner's UI/UX design (UIUX-HANDOFF-P2 build_p8, the attorney
// workspace Settings & help, Help & support): the workspace frame around the
// design's Settings categories and panel, the existing report form and the
// attorney's own reports as the design's rows. A visitor the page does not
// admit sees the design's signed-out panel.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveAttorneyComplaints } from "../../../src/application/complaints.ts";
import { resolveAttorneyConsultations } from "../../../src/application/consultations.ts";
import { isUuid } from "../../../src/application/professional-records.ts";
import { ATTORNEY_COMPLAINT_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { ATTORNEY_CONSULTATION_SOURCES } from "../../../src/infrastructure/consultations/consultation-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import {
  AttorneyGate,
  AttorneyWorkspace,
  Pill,
  SettingsPanel,
} from "../../../src/presentation/attorney-workspace.tsx";
import {
  COMPLAINT_NOTE,
  COMPLAINT_STATE_LABELS,
  utcText,
} from "../../../src/presentation/completion-labels.ts";
import {
  ATTORNEY_STATE_LABELS,
  modalityText,
} from "../../../src/presentation/consultation-labels.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { ReportForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Report a problem",
  robots: { index: false, follow: false },
};

const BACK = (
  <Cluster>
    <ButtonLink variant="tertiary" href="/attorney">
      Back to your workspace
    </ButtonLink>
  </Cluster>
);

function GateFrame({ children }: { readonly children: ReactNode }) {
  return (
    <AttorneyGate titleId="attorney-complaints-title" title="Report a problem">
      {children}
      {BACK}
    </AttorneyGate>
  );
}

export default async function AttorneyComplaintsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly consultation?: string | string[];
  }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const { consultation } = await searchParams;
  const view = await resolveAttorneyComplaints(ATTORNEY_COMPLAINT_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <GateFrame>
        <Text tone="muted">Sign in to report a problem.</Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </GateFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <GateFrame>
        <Alert tone="warning" title="Not available" role="status">
          This account cannot report problems here.
        </Alert>
      </GateFrame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "complaint.view_unavailable", {
      route: "/attorney/complaints",
      outcome: view.status,
    });
    return (
      <GateFrame>
        <Alert tone="error" title="Something went wrong" role="alert">
          Your reports could not be shown right now. Please try again later.
        </Alert>
      </GateFrame>
    );
  }
  const list = await resolveAttorneyConsultations(
    ATTORNEY_CONSULTATION_SOURCES,
  );
  const consultations =
    list.status === "ready"
      ? list.entries.map((entry) => ({
          id: entry.id,
          label: `${modalityText(entry.modality)}, ${ATTORNEY_STATE_LABELS[entry.state].label}${
            entry.bookingStart === null
              ? ""
              : `, ${utcText(entry.bookingStart)}`
          }`,
        }))
      : [];
  const selected =
    typeof consultation === "string" && isUuid(consultation)
      ? consultation
      : null;
  const choices =
    selected === null || consultations.some((entry) => entry.id === selected)
      ? consultations
      : [
          { id: selected, label: "The consultation you came from" },
          ...consultations,
        ];
  return (
    <AttorneyWorkspace
      section="settings"
      titleId="attorney-complaints-title"
      title="Settings & help"
      width="settings"
    >
      <SettingsPanel
        current="/attorney/complaints"
        labelledBy="attorney-report-title"
      >
        <div className="w-seth">
          <h2 className="set-h" id="attorney-report-title">
            Report a problem
          </h2>
        </div>
        <p className="sm muted w-setlead">{COMPLAINT_NOTE}</p>
        <div className="aw-form aw-setform">
          <ReportForm consultations={choices} selected={selected} />
        </div>
        <h3 className="w-setgrp" id="attorney-reports-title">
          Your reports
        </h3>
        {view.cases.length === 0 ? (
          <Text>You have not reported a problem.</Text>
        ) : (
          <ul className="aw-rows" aria-labelledby="attorney-reports-title">
            {view.cases.map((entry) => (
              <li className="set-row" key={entry.id}>
                <div>
                  <p className="b" id={`report-${entry.id}`}>
                    {`Reported ${utcText(entry.openedAt)}`}
                  </p>
                  {entry.resolvedAt === null ? null : (
                    <p className="xs subtle">{`Resolved ${utcText(entry.resolvedAt)}`}</p>
                  )}
                  {entry.statement === null ? null : (
                    <p className="xs subtle aw-wraps">{`What you described: ${entry.statement}`}</p>
                  )}
                  {entry.consultationId === null ? null : (
                    <a
                      className="link xs"
                      href={`/attorney/consultations/${entry.consultationId}`}
                    >
                      Open the consultation
                    </a>
                  )}
                </div>
                <Pill tone={COMPLAINT_STATE_LABELS[entry.state].tone}>
                  {COMPLAINT_STATE_LABELS[entry.state].label}
                </Pill>
              </li>
            ))}
          </ul>
        )}
      </SettingsPanel>
      {BACK}
    </AttorneyWorkspace>
  );
}
