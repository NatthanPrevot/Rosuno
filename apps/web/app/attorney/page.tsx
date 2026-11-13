// Protected existing-attorney workspace entry (P3-001).
//
// Rendered on the server for every request: the trusted server session and
// the trusted attorney principal source decide access through the unchanged
// Security Shell, and the page shows only the fixed state that results.
// Direct entry and every repeated request are decided the same way. The page
// reads no route parameter, query, header, cookie, or form field of its own,
// offers no form or mutation, and redirects nowhere. An admitted attorney sees
// a restricted entry that keeps active User account access, the Attorney
// Profile lifecycle stage, professional verification, and current eligibility
// apart: this page establishes no verification and determines no
// eligibility, and points to the professional setup (P3-003), which shows
// claims, evidence status, and recorded determinations separately. Refused
// and unavailable requests each see one fixed message and no profile data;
// every refusal also offers the same fixed link to the attorney application
// entry (P3-002), which decides afresh on its own.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import {
  resolveAttorneyWorkspaceAccess,
  type AttorneyWorkspaceStage,
} from "../../src/application/attorney-access.ts";
import { ATTORNEY_PRINCIPAL_SOURCE } from "../../src/infrastructure/identity/attorney-principal-source.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../src/infrastructure/identity/server-session-source.ts";
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
} from "../../src/presentation/design-system.tsx";

export const metadata: Metadata = {
  title: "Attorney workspace",
  robots: { index: false, follow: false },
};

// How each admitted lifecycle stage is named. Each is a record stage only.
const STAGE_LABELS: Readonly<Record<AttorneyWorkspaceStage, string>> = {
  applicant: "Applicant",
  under_review: "Under review",
  approved: "Approved (record stage only)",
};

type WorkspaceFrameProps = {
  readonly title: string;
  readonly children: ReactNode;
};

function WorkspaceFrame({ title, children }: WorkspaceFrameProps) {
  return (
    <Page density="attorney">
      <Surface emphasis="raised" labelledBy="attorney-workspace-title">
        <Stack>
          <Eyebrow>Attorney workspace</Eyebrow>
          <Heading as="h1" size="lg" id="attorney-workspace-title">
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

export default async function AttorneyWorkspacePage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const access = await resolveAttorneyWorkspaceAccess({
    session: SUPABASE_SERVER_SESSION_SOURCE,
    attorney: ATTORNEY_PRINCIPAL_SOURCE,
  });
  if (access.status === "granted") {
    return (
      <WorkspaceFrame title="Restricted attorney workspace">
        <Text tone="muted">
          Your signed-in account has an existing attorney profile that permits
          entry to this restricted workspace. It shows access standing only and
          changes nothing.
        </Text>
        <Table id="attorney-workspace-standing" caption="Access standing">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Current state</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Workspace access</th>
              <td>
                <Status tone="success">Restricted entry permitted</Status>
              </td>
            </tr>
            <tr>
              <th scope="row">User account</th>
              <td>
                <Status tone="success">Active</Status>
              </td>
            </tr>
            <tr>
              <th scope="row">Attorney profile lifecycle</th>
              <td>
                <Status tone="neutral">{STAGE_LABELS[access.stage]}</Status>
              </td>
            </tr>
            <tr>
              <th scope="row">Professional verification</th>
              <td>
                <Status tone="neutral">Shown in professional setup</Status>
              </td>
            </tr>
            <tr>
              <th scope="row">Current eligibility</th>
              <td>
                <Status tone="neutral">Shown in professional setup</Status>
              </td>
            </tr>
          </tbody>
        </Table>
        <Alert tone="information" title="Access is not verification">
          Entry to this workspace does not establish professional verification
          or determine current eligibility. An attorney profile lifecycle stage,
          approved included, is a record stage that establishes neither, and
          this workspace makes no such decision. Your claims, their review, and
          any recorded eligibility determination are shown separately in
          professional setup.
        </Alert>
        <Cluster>
          <ButtonLink variant="primary" href="/attorney/professional">
            Professional setup
          </ButtonLink>
          <ButtonLink variant="tertiary" href="/">
            Return to the home page
          </ButtonLink>
        </Cluster>
      </WorkspaceFrame>
    );
  }
  if (access.status === "sign-in-required") {
    return (
      <WorkspaceFrame title="Sign in to continue">
        <Text tone="muted">
          The attorney workspace is available only to a signed-in account with
          existing attorney access.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
          <ButtonLink variant="tertiary" href="/">
            Return to the home page
          </ButtonLink>
        </Cluster>
      </WorkspaceFrame>
    );
  }
  if (access.status === "denied") {
    return (
      <WorkspaceFrame title="Attorney workspace not available">
        <Alert tone="warning" title="No workspace access" role="status">
          This account does not have access to the attorney workspace. Any other
          access the account has is unchanged.
        </Alert>
        <Cluster>
          <ButtonLink variant="secondary" href="/attorney/apply">
            Attorney application
          </ButtonLink>
          <ButtonLink variant="tertiary" href="/">
            Return to the home page
          </ButtonLink>
        </Cluster>
      </WorkspaceFrame>
    );
  }
  return (
    <WorkspaceFrame title="Attorney workspace unavailable">
      <Alert tone="error" title="Access could not be confirmed" role="alert">
        The attorney workspace could not be opened right now. Please try again
        later.
      </Alert>
      <Cluster>
        <ButtonLink variant="tertiary" href="/">
          Return to the home page
        </ButtonLink>
      </Cluster>
    </WorkspaceFrame>
  );
}
