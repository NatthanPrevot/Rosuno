// Staff verification queue (P3-003).
//
// Rendered on the server for every request. A fresh Staff identity and the
// database's own verification scope predicate decide access; the queue lists
// only what the reviewer's own session may read under the row policies, and
// never the reviewer's own attorney profile. The page reads no route
// parameter, query, header, or cookie of its own and offers no change.

import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveStaffQueue } from "../../../src/application/staff-verification.ts";
import type { ProfileState } from "../../../src/application/professional-records.ts";
import { STAFF_VERIFICATION_SOURCES } from "../../../src/infrastructure/staff/staff-verification-adapter.ts";
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

export const metadata: Metadata = {
  title: "Verification review",
  robots: { index: false, follow: false },
};

const STAGE_LABELS: Readonly<Record<ProfileState, string>> = {
  applicant: "Applicant (editing)",
  under_review: "Under review",
  approved: "Approved (stage only)",
  suspended: "Suspended",
  removed: "Removed",
};

function StaffFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Page density="admin">
      <Surface emphasis="raised" labelledBy="staff-verification-title">
        <Stack>
          <Eyebrow>Staff verification</Eyebrow>
          <Heading as="h1" size="lg" id="staff-verification-title">
            {title}
          </Heading>
          {children}
        </Stack>
      </Surface>
    </Page>
  );
}

export default async function StaffVerificationQueuePage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const view = await resolveStaffQueue(STAFF_VERIFICATION_SOURCES);
  if (view.status === "sign-in-required") {
    return (
      <StaffFrame title="Sign in to continue">
        <Text tone="muted">
          Verification review is available only to signed-in staff with the
          required access.
        </Text>
        <Cluster>
          <ButtonLink variant="primary" href="/sign-in">
            Sign in
          </ButtonLink>
        </Cluster>
      </StaffFrame>
    );
  }
  if (view.status === "denied") {
    return (
      <StaffFrame title="Verification review not available">
        <Alert tone="warning" title="No verification access" role="status">
          This account does not hold current verification access. A staff
          profile alone grants none.
        </Alert>
      </StaffFrame>
    );
  }
  if (view.status === "unavailable") {
    return (
      <StaffFrame title="Verification review unavailable">
        <Alert tone="error" title="Access could not be confirmed" role="alert">
          Verification review could not be opened right now. Please try again
          later.
        </Alert>
      </StaffFrame>
    );
  }
  return (
    <StaffFrame title="Verification review queue">
      <Text tone="muted">
        {`Your current scope: ${view.scope.join(", ")}.`}
      </Text>
      {view.global ? null : (
        <Alert tone="information" title="Jurisdiction-scoped access">
          Profile details and profile-stage changes need jurisdiction-free
          access. You can review the professional records in your jurisdictions.
        </Alert>
      )}
      {view.entries.length === 0 ? (
        <Text tone="muted">Nothing in your scope is waiting.</Text>
      ) : (
        <Table
          id="verification-queue"
          caption="Applications and records in scope"
        >
          <thead>
            <tr>
              <th scope="col">Attorney</th>
              <th scope="col">Profile stage</th>
              <th scope="col">License claims</th>
              <th scope="col">Pending practice-area requests</th>
              <th scope="col">Review</th>
            </tr>
          </thead>
          <tbody>
            {view.entries.map((entry) => (
              <tr key={entry.attorneyId}>
                <td>{entry.name}</td>
                <td>
                  {entry.stage === null ? (
                    "Not in your scope"
                  ) : (
                    <Status tone="neutral">{STAGE_LABELS[entry.stage]}</Status>
                  )}
                </td>
                <td>{entry.licenseClaims}</td>
                <td>{entry.pendingRequests}</td>
                <td>
                  <ButtonLink
                    variant="tertiary"
                    href={`/staff/verification/${entry.attorneyId}`}
                  >
                    Open review
                  </ButtonLink>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </StaffFrame>
  );
}
