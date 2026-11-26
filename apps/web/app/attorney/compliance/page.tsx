// The attorney's compliance page (MVP-001 S11 pass 2B; MBS section 18.3
// "compliance").
//
// Rendered on the server for every request and never indexed. The step-up
// gate comes first (MVP-001 S2); then the professional setup's own reads
// decide access and answer the attorney's profile stage, licences (with the
// waitlist state of their jurisdiction and the verification status of each
// claim), insurance, practice-area authorisations and the latest recorded
// Eligibility per jurisdiction and context; the database adds the attorney's
// own record dates (the recorded end dates and the date the latest evidence
// reaches the in-force eligibility policy's stated age) and the discipline
// findings recorded about the attorney. Strictly the attorney's own records:
// never verification evidence content, a reviewer, or another attorney.
// Nothing here verifies, approves, decides eligibility or changes anything;
// claims are changed in the professional profile.
//
// DEV-001: the owner's UI/UX design (UIUX-HANDOFF-P2 build_p8, the attorney
// workspace Compliance & readiness): the workspace frame around the design's
// list of groups (profile, dates to note, licences, insurance, discipline
// findings, practice areas and recorded eligibility), each with what the
// records hold in words. Nothing here verifies, approves or decides. A
// visitor the page does not admit sees the design's signed-out panel.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveAttorneyCompliance } from "../../../src/application/participant-workspaces.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { ATTORNEY_PROFESSIONAL_SOURCES } from "../../../src/infrastructure/professional/attorney-professional-adapter.ts";
import { ATTORNEY_WORKSPACE_SOURCES } from "../../../src/infrastructure/workspaces/workspace-adapter.ts";
import {
  AttorneyGate,
  AttorneyWorkspace,
  Calm,
  ExpandGroup,
  Pill,
} from "../../../src/presentation/attorney-workspace.tsx";
import {
  Alert,
  ButtonLink,
  Cluster,
  Status,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import {
  AUTHORISATION_LABELS,
  COMPLIANCE_ALERT_NOTE,
  COMPLIANCE_INTRO,
  ELIGIBILITY_LABELS,
  evidenceAgedText,
  lapsedText,
  nextDateText,
  NO_DISCIPLINE,
  NOT_RECORDED,
  openFindingsText,
  PROFILE_STAGE_LABELS,
  utcText,
  VERIFICATION_LABELS,
  WAITLIST_NOTE,
} from "../../../src/presentation/workspace-labels.ts";
import { requireSteppedUp } from "../../account/gate.ts";

export const metadata: Metadata = {
  title: "Compliance",
  robots: { index: false, follow: false },
};

function GateFrame({ children }: { readonly children: ReactNode }) {
  return (
    <AttorneyGate titleId="attorney-compliance-title" title="Compliance">
      {children}
    </AttorneyGate>
  );
}

const shown = (value: string | null | undefined) =>
  value === null || value === undefined || value === "" ? NOT_RECORDED : value;

const recorded = (count: number) =>
  count === 0 ? "None recorded" : `${count} recorded`;

export default async function AttorneyCompliancePage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("attorney");
  const view = await resolveAttorneyCompliance({
    professional: ATTORNEY_PROFESSIONAL_SOURCES,
    workspace: ATTORNEY_WORKSPACE_SOURCES,
  });
  if (view.status === "sign-in-required") {
    return (
      <GateFrame>
        <Text tone="muted">
          Compliance is available only to a signed-in account with an attorney
          profile.
        </Text>
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
          This account does not have attorney compliance records.
        </Alert>
      </GateFrame>
    );
  }
  if (view.status === "no-application") {
    return (
      <AttorneyWorkspace
        section="compliance"
        titleId="attorney-compliance-title"
        title="Compliance & readiness"
        width="narrow"
      >
        <Calm
          title="No compliance records yet"
          note="This account has no attorney application yet, so there are no compliance records to show."
        />
        <Cluster>
          <ButtonLink variant="secondary" href="/attorney/professional">
            Professional profile
          </ButtonLink>
        </Cluster>
      </AttorneyWorkspace>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "attorney_compliance.unavailable", {
      route: "/attorney/compliance",
      outcome: view.status,
    });
    return (
      <GateFrame>
        <Alert tone="error" title="Something went wrong" role="alert">
          Your compliance records could not be shown right now. Please try again
          later.
        </Alert>
      </GateFrame>
    );
  }
  const { setup, records, alerts, jurisdictionNames } = view;
  const recordOf = (id: string) => records.find((r) => r.id === id);
  const findings = records.filter((r) => r.kind === "discipline");
  const passed = alerts.lapsed + alerts.evidenceAged;
  return (
    <AttorneyWorkspace
      section="compliance"
      titleId="attorney-compliance-title"
      title="Compliance & readiness"
      description="Your professional records as Rosuno has recorded them"
      width="narrow"
    >
      <p className="xs subtle aw-lead">{COMPLIANCE_INTRO}</p>
      <section className="w-box w-crl" aria-label="Your compliance records">
        <ExpandGroup
          title="Profile"
          note="The stage of your attorney profile"
          summary={
            <Pill tone="neutral">{PROFILE_STAGE_LABELS[setup.stage]}</Pill>
          }
        >
          <Table id="compliance-standing" caption="Profile">
            <tbody>
              <tr>
                <th scope="row">Profile stage</th>
                <td>
                  <Status tone="neutral">
                    {PROFILE_STAGE_LABELS[setup.stage]}
                  </Status>
                </td>
              </tr>
            </tbody>
          </Table>
        </ExpandGroup>
        <ExpandGroup
          title="Dates to note"
          note={COMPLIANCE_ALERT_NOTE}
          summary={
            passed > 0 ? (
              <Pill tone="warning">{`${passed} to note`}</Pill>
            ) : (
              <Pill tone="neutral">None passed</Pill>
            )
          }
        >
          <div className="aw-crrows">
            {alerts.lapsed === 0 ? null : (
              <Status tone="warning">{lapsedText(alerts.lapsed)}</Status>
            )}
            {alerts.evidenceAged === 0 ? null : (
              <Status tone="warning">
                {evidenceAgedText(alerts.evidenceAged)}
              </Status>
            )}
            {alerts.openFindings === 0 ? null : (
              <Status tone="information">
                {openFindingsText(alerts.openFindings)}
              </Status>
            )}
            <Text>{nextDateText(alerts.nextDate)}</Text>
          </div>
        </ExpandGroup>
        <ExpandGroup
          title="Licences"
          note="Each licence claim with its recorded dates and review"
          summary={
            <Pill tone="neutral">{recorded(setup.licenses.length)}</Pill>
          }
        >
          {setup.licenses.length === 0 ? (
            <Text tone="muted">No licence claim is recorded.</Text>
          ) : (
            <Table id="compliance-licence-table" caption="Your licences">
              <thead>
                <tr>
                  <th scope="col">Jurisdiction</th>
                  <th scope="col">Valid until</th>
                  <th scope="col">Evidence reaches its age</th>
                  <th scope="col">Verification</th>
                </tr>
              </thead>
              <tbody>
                {setup.licenses.map((license) => {
                  const verification =
                    VERIFICATION_LABELS[license.verification];
                  return (
                    <tr key={license.id}>
                      <th scope="row">
                        {license.jurisdiction}
                        {license.waitlist ? (
                          <>
                            {" "}
                            <Status tone="neutral">Waitlist</Status>
                          </>
                        ) : null}
                      </th>
                      <td>{shown(recordOf(license.id)?.endsOn)}</td>
                      <td>{shown(recordOf(license.id)?.evidenceLapsesOn)}</td>
                      <td>
                        <Status tone={verification.tone}>
                          {verification.label}
                        </Status>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          {setup.licenses.some((license) => license.waitlist) ? (
            <p className="xs subtle aw-crnote">{WAITLIST_NOTE}</p>
          ) : null}
        </ExpandGroup>
        <ExpandGroup
          title="Insurance"
          note="Each insurance claim with its recorded dates and review"
          summary={
            <Pill tone="neutral">{recorded(setup.insurance.length)}</Pill>
          }
        >
          {setup.insurance.length === 0 ? (
            <Text tone="muted">No insurance claim is recorded.</Text>
          ) : (
            <Table id="compliance-insurance-table" caption="Your insurance">
              <thead>
                <tr>
                  <th scope="col">Jurisdiction</th>
                  <th scope="col">Covered until</th>
                  <th scope="col">Evidence reaches its age</th>
                  <th scope="col">Verification</th>
                </tr>
              </thead>
              <tbody>
                {setup.insurance.map((record) => {
                  const verification = VERIFICATION_LABELS[record.verification];
                  return (
                    <tr key={record.id}>
                      <th scope="row">{record.jurisdiction}</th>
                      <td>{shown(recordOf(record.id)?.endsOn)}</td>
                      <td>{shown(recordOf(record.id)?.evidenceLapsesOn)}</td>
                      <td>
                        <Status tone={verification.tone}>
                          {verification.label}
                        </Status>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </ExpandGroup>
        <ExpandGroup
          title="Discipline findings"
          note="Findings recorded against your licences"
          summary={<Pill tone="neutral">{recorded(findings.length)}</Pill>}
        >
          {findings.length === 0 ? (
            <Text tone="muted">{NO_DISCIPLINE}</Text>
          ) : (
            <Table id="compliance-discipline-table" caption="Recorded findings">
              <thead>
                <tr>
                  <th scope="col">Jurisdiction</th>
                  <th scope="col">Recorded status</th>
                  <th scope="col">Opened</th>
                  <th scope="col">Resolved</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((finding) => (
                  <tr key={finding.id}>
                    <th scope="row">
                      {shown(
                        finding.jurisdictionId === null
                          ? null
                          : jurisdictionNames.get(finding.jurisdictionId),
                      )}
                    </th>
                    <td>{shown(finding.statusCode)}</td>
                    <td>{shown(finding.startsOn)}</td>
                    <td>{shown(finding.endsOn)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </ExpandGroup>
        <ExpandGroup
          title="Practice-area authorisations"
          note="The practice areas you asked for, by jurisdiction"
          summary={
            <Pill tone="neutral">{recorded(setup.authorisations.length)}</Pill>
          }
        >
          {setup.authorisations.length === 0 ? (
            <Text tone="muted">No practice-area request is recorded.</Text>
          ) : (
            <Table id="compliance-area-table" caption="Your practice areas">
              <thead>
                <tr>
                  <th scope="col">Practice area</th>
                  <th scope="col">Jurisdiction</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {setup.authorisations.map((entry) => (
                  <tr key={entry.id}>
                    <th scope="row">{entry.practiceArea}</th>
                    <td>{entry.jurisdiction}</td>
                    <td>{AUTHORISATION_LABELS[entry.status]}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </ExpandGroup>
        <ExpandGroup
          title="Recorded eligibility"
          note="The latest determination recorded for each jurisdiction and context"
          summary={
            <Pill tone="neutral">{recorded(setup.eligibility.length)}</Pill>
          }
        >
          {setup.eligibility.length === 0 ? (
            <Text tone="muted">No eligibility determination is recorded.</Text>
          ) : (
            <Table id="compliance-eligibility-table" caption="Latest recorded">
              <thead>
                <tr>
                  <th scope="col">Jurisdiction</th>
                  <th scope="col">Context</th>
                  <th scope="col">Result</th>
                  <th scope="col">Recorded</th>
                </tr>
              </thead>
              <tbody>
                {setup.eligibility.map((entry) => {
                  const result = ELIGIBILITY_LABELS[entry.result];
                  return (
                    <tr key={`${entry.jurisdiction}|${entry.context}`}>
                      <th scope="row">{entry.jurisdiction}</th>
                      <td>{entry.context}</td>
                      <td>
                        <Status tone={result.tone}>{result.label}</Status>
                      </td>
                      <td>{utcText(entry.evaluatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </ExpandGroup>
      </section>
      <Cluster>
        <ButtonLink variant="secondary" href="/attorney/professional">
          Professional profile
        </ButtonLink>
      </Cluster>
    </AttorneyWorkspace>
  );
}
