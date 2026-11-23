// Attorney lifecycle operations (MVP-001 S11 pass 2; DM section 5; TA
// section 18 "attorney operations incl. suspensions/removals"; MB sections
// 19 and 81 to 90).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs the global manage_attorney_verification grant,
// the rule of the existing suspend intent (the database decides again). One
// profile's stage, with reinstatement for a suspended profile and removal
// (final) for an approved or suspended one, each with a staff note; the
// database never lets staff act on their own profile and holds a
// reinstatement while a rejoin review is open. An unknown or malformed
// identifier shows that no profile is available. The one route value read,
// attorney, only names the profile.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  lifecycleIntentsFor,
  resolveAttorneyLifecycle,
} from "../../../../src/application/administration-workspace.ts";
import { ADMINISTRATION_SOURCES } from "../../../../src/infrastructure/staff/operations-adapter.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Status,
  Table,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import {
  PROFILE_STAGE_LABELS,
  REJOIN_REVIEW_NOTE,
  utcText,
} from "../../../../src/presentation/operations-labels.ts";
import { requireSteppedUp } from "../../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../../frame.tsx";
import { AttorneyLifecyclePanel } from "../forms.tsx";

export const metadata: Metadata = {
  title: "Attorney operations",
  robots: { index: false, follow: false },
};

export default async function AttorneyOperationsPage({
  params,
}: {
  readonly params: Promise<{ readonly attorney: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { attorney: attorneyId } = await params;
  const view = await resolveAttorneyLifecycle(
    ADMINISTRATION_SOURCES,
    attorneyId,
  );
  if (view.status !== "ready") {
    return refusalPage(
      view,
      "/staff/attorneys/[attorney]",
      "Attorney operations",
    );
  }
  const { attorney } = view;
  if (attorney === null) {
    return (
      <StaffFrame eyebrow="Attorneys" title="Attorney operations">
        <BackLink href="/staff/compliance">Compliance</BackLink>
        <Text>No such attorney profile is available.</Text>
      </StaffFrame>
    );
  }
  const stage = PROFILE_STAGE_LABELS[attorney.state];
  const intents = lifecycleIntentsFor(attorney.state);
  return (
    <StaffFrame eyebrow="Attorneys" title="Attorney operations">
      <BackLink href="/staff/compliance">Compliance</BackLink>
      <Table id="attorney-profile" caption="Attorney profile">
        <tbody>
          <tr>
            <th scope="row">Profile identifier</th>
            <td>{attorney.id}</td>
          </tr>
          <tr>
            <th scope="row">Name</th>
            <td>{attorney.displayName ?? "No name recorded"}</td>
          </tr>
          <tr>
            <th scope="row">Stage</th>
            <td>
              <Status tone={stage.tone}>{stage.label}</Status>
            </td>
          </tr>
          <tr>
            <th scope="row">Last changed (UTC)</th>
            <td>{utcText(attorney.updatedAt)}</td>
          </tr>
        </tbody>
      </Table>
      <Cluster>
        <ButtonLink
          variant="secondary"
          href={`/staff/verification/${attorney.id}`}
        >
          Open the verification record
        </ButtonLink>
      </Cluster>
      {attorney.rejoinReviewOpen ? (
        <Alert tone="warning" title="Compliance review open" role="status">
          {REJOIN_REVIEW_NOTE}
        </Alert>
      ) : null}
      <AttorneyLifecyclePanel attorney={attorney.id} intents={intents} />
    </StaffFrame>
  );
}
