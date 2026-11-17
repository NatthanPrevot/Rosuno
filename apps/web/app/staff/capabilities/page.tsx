// Staff capabilities: staff members (MVP-001 S1).
//
// Rendered on the server for every request. A fresh staff identity and the
// database's own capability predicate decide access: capability
// administration needs the manage_staff_capabilities capability for all
// jurisdictions, exactly as its row policies and functions do. Staff members
// are listed one page at a time. The one query value read, page, only asks
// which page to show; the server checks it.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveCapabilityAdministration } from "../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import {
  ButtonLink,
  Status,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { BackLink, PagerLinks, refusalPage, StaffFrame } from "../frame.tsx";

export const metadata: Metadata = {
  title: "Staff capabilities",
  robots: { index: false, follow: false },
};

export default async function CapabilitiesPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string | string[] }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const { page } = await searchParams;
  const view = await resolveCapabilityAdministration(
    STAFF_CONFIGURATION_SOURCES,
    page,
  );
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/capabilities", "Staff capabilities");
  }
  return (
    <StaffFrame eyebrow="Staff configuration" title="Staff capabilities">
      <BackLink href="/staff">Staff tools</BackLink>
      <Text tone="muted">
        A staff profile alone grants nothing. Each capability is a separate
        grant, for all jurisdictions or one, and can expire or be revoked.
      </Text>
      {view.members.length === 0 ? (
        <Text>There are no staff members on this page.</Text>
      ) : (
        <Table id="staff-members" caption="Staff members">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Account</th>
              <th scope="col">Staff profile</th>
              <th scope="col">Capabilities</th>
            </tr>
          </thead>
          <tbody>
            {view.members.map((member) => (
              <tr key={member.userId}>
                <td>{member.isYou ? `${member.name} (you)` : member.name}</td>
                <td>
                  <Status
                    tone={
                      member.accountState === "active" ? "success" : "neutral"
                    }
                  >
                    {member.accountState}
                  </Status>
                </td>
                <td>
                  <Status
                    tone={
                      member.staffState === "active" ? "success" : "neutral"
                    }
                  >
                    {member.staffState}
                  </Status>
                </td>
                <td>
                  <ButtonLink
                    variant="tertiary"
                    href={`/staff/capabilities/${member.userId}`}
                  >
                    Open
                  </ButtonLink>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <PagerLinks
        pager={view.pager}
        base="/staff/capabilities"
        noun="staff members"
        shown={view.members.length}
      />
    </StaffFrame>
  );
}
