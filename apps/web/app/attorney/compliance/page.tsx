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

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveAttorneyCompliance } from "../../../src/application/participant-workspaces.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { ATTORNEY_PROFESSIONAL_SOURCES } from "../../../src/infrastructure/professional/attorney-professional-adapter.ts";
import { ATTORNEY_WORKSPACE_SOURCES } from "../../../src/infrastructure/workspaces/workspace-adapter.ts";
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
import { AttorneyNavigation } from "../../../src/presentation/workspace-navigation.tsx";
import { requireSteppedUp } from "../../account/gate.ts";

export const metadata: Metadata = {
  title: "Compliance",
  robots: { index: false, follow: false },
};

function Frame({ children }: { readonly children: ReactNode }) {
  return (
    <Page density="attorney">
      <Surface emphasis="raised" labelledBy="attorney-compliance-title">
        <Stack>
          <Eyebrow>Attorney workspace</Eyebrow>
          <Heading as="h1" size="lg" id="attorney-compliance-title">
            Compliance
          </Heading>
          {children}
          <AttorneyNavigation current="/attorney/compliance" />
        </Stack>
      </Surface>
    </Page>
  );
}

const shown = (value: string | null | undefined) =>
  value === null || value === undefined || value === "" ? NOT_RECORDED : value;

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
      <Frame>
        <Text tone="muted">
          Compliance is available only to a signed-in account with an attorney
          profile.
        </Text>
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
          This account does not have attorney compliance records.
        </Alert>
      </Frame>
    );
  }
  if (view.status === "no-application") {
    return (
      <Frame>
        <Text tone="muted">
          This account has no attorney application yet, so there are no
          compliance records to show.
        </Text>
        <Cluster>
          <ButtonLink variant="secondary" href="/attorney/professional">
            Professional profile
          </ButtonLink>
        </Cluster>
      </Frame>
    );
  }
  if (view.status !== "ready") {
    await logRequestEvent("warn", "attorney_compliance.unavailable", {
      route: "/attorney/compliance",
      outcome: view.status,
    });
    return (
      <Frame>
        <Alert tone="error" title="Something went wrong" role="alert">
          Your compliance records could not be shown right now. Please try again
          later.
        </Alert>
      </Frame>
    );
  }
  const { setup, records, alerts, jurisdictionNames } = view;
  const recordOf = (id: string) => records.find((r) => r.id === id);
  const findings = records.filter((r) => r.kind === "discipline");
  return (
    <Frame>
      <Text tone="muted">{COMPLIANCE_INTRO}</Text>
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
      <Heading as="h2" size="md" id="compliance-alerts">
        Dates to note
      </Heading>
      <Text size="small" tone="muted">
        {COMPLIANCE_ALERT_NOTE}
      </Text>
      {alerts.lapsed === 0 ? null : (
        <Status tone="warning">{lapsedText(alerts.lapsed)}</Status>
      )}
      {alerts.evidenceAged === 0 ? null : (
        <Status tone="warning">{evidenceAgedText(alerts.evidenceAged)}</Status>
      )}
      {alerts.openFindings === 0 ? null : (
        <Status tone="information">
          {openFindingsText(alerts.openFindings)}
        </Status>
      )}
      <Text>{nextDateText(alerts.nextDate)}</Text>
      <Heading as="h2" size="md" id="compliance-licences">
        Licences
      </Heading>
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
              const verification = VERIFICATION_LABELS[license.verification];
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
        <Text size="small" tone="muted">
          {WAITLIST_NOTE}
        </Text>
      ) : null}
      <Heading as="h2" size="md" id="compliance-insurance">
        Insurance
      </Heading>
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
      <Heading as="h2" size="md" id="compliance-discipline">
        Discipline findings
      </Heading>
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
      <Heading as="h2" size="md" id="compliance-areas">
        Practice-area authorisations
      </Heading>
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
      <Heading as="h2" size="md" id="compliance-eligibility">
        Recorded eligibility
      </Heading>
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
      <Cluster>
        <ButtonLink variant="secondary" href="/attorney/professional">
          Professional profile
        </ButtonLink>
      </Cluster>
    </Frame>
  );
}
