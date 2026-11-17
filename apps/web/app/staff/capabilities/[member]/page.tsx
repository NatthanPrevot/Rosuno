// One staff member's capabilities (MVP-001 S1).
//
// Rendered on the server for every request. The route segment only names
// which staff member to look at: a fresh staff identity and the database's
// own capability predicate decide access, and a member the caller's session
// cannot read looks exactly like one that does not exist. A grant is offered
// only to an active staff member other than the caller; the database refuses
// a self-grant and an inactive target again.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveMemberCapabilities } from "../../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import {
  Alert,
  Disclosure,
  Heading,
  Status,
  Table,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import {
  GRANT_STATE_LABELS,
  utcDateTime,
} from "../../../../src/presentation/staff-configuration-labels.ts";
import { requireSteppedUp } from "../../../account/gate.ts";
import {
  BackLink,
  BoundNotice,
  refusalPage,
  StaffFrame,
} from "../../frame.tsx";
import { GrantCapabilityForm, RevokeCapabilityForm } from "../forms.tsx";

export const metadata: Metadata = {
  title: "Staff member capabilities",
  robots: { index: false, follow: false },
};

export default async function MemberCapabilitiesPage({
  params,
}: {
  readonly params: Promise<{ readonly member: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { member } = await params;
  const view = await resolveMemberCapabilities(
    STAFF_CONFIGURATION_SOURCES,
    member,
  );
  if (view.status !== "ready") {
    return refusalPage(
      view,
      "/staff/capabilities/[member]",
      "Staff member capabilities",
    );
  }
  const m = view.member;
  return (
    <StaffFrame
      eyebrow="Staff capabilities"
      title={m.isYou ? `${m.name} (you)` : m.name}
    >
      <BackLink href="/staff/capabilities">Back to staff members</BackLink>
      <Table id="staff-member" caption="Staff member">
        <tbody>
          <tr>
            <th scope="row">Account</th>
            <td>{m.accountState}</td>
          </tr>
          <tr>
            <th scope="row">Staff profile</th>
            <td>{m.staffState}</td>
          </tr>
        </tbody>
      </Table>
      <Heading as="h2" size="md">
        Capability grants
      </Heading>
      <BoundNotice complete={view.grantsComplete} noun="grants" />
      {view.grants.length === 0 ? (
        <Text tone="muted">No capability has been granted.</Text>
      ) : (
        <Table id="grants" caption="Grants, newest first">
          <thead>
            <tr>
              <th scope="col">Capability</th>
              <th scope="col">Scope</th>
              <th scope="col">Granted</th>
              <th scope="col">Expires</th>
              <th scope="col">State</th>
              <th scope="col">Change</th>
            </tr>
          </thead>
          <tbody>
            {view.grants.map((grant) => (
              <tr key={grant.id}>
                <td>{grant.capability}</td>
                <td>{grant.jurisdiction}</td>
                <td>{utcDateTime(grant.grantedAt)}</td>
                <td>
                  {grant.expiresAt === null
                    ? "Does not expire"
                    : utcDateTime(grant.expiresAt)}
                </td>
                <td>
                  <Status tone={GRANT_STATE_LABELS[grant.state].tone}>
                    {grant.revokedAt === null
                      ? GRANT_STATE_LABELS[grant.state].label
                      : `${GRANT_STATE_LABELS[grant.state].label} ${utcDateTime(grant.revokedAt)}`}
                  </Status>
                </td>
                <td>
                  {grant.revokedAt === null ? (
                    <RevokeCapabilityForm grant={grant.id} />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {view.canGrant ? (
        <>
          <BoundNotice
            complete={view.capabilitiesComplete}
            noun="capabilities"
          />
          <BoundNotice
            complete={view.jurisdictionsComplete}
            noun="jurisdictions"
          />
          <Disclosure summary="Grant a capability">
            <GrantCapabilityForm
              member={m.userId}
              capabilities={view.capabilities}
              jurisdictions={view.jurisdictions}
            />
          </Disclosure>
        </>
      ) : (
        <Alert tone="information" role="status">
          {m.isYou
            ? "You cannot grant capabilities to yourself. Another staff member with capability administration must do it."
            : "Capabilities can be granted only to an active User with an active staff profile."}
        </Alert>
      )}
    </StaffFrame>
  );
}
