// Staff capabilities: staff members (MVP-001 S1).
//
// Rendered on the server for every request. A fresh staff identity and the
// database's own capability predicate decide access: capability
// administration needs the manage_staff_capabilities capability for all
// jurisdictions, exactly as its row policies and functions do. Staff members
// are listed one page at a time. The one query value read, page, only asks
// which page to show; the server checks it.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Administration › Staff,
// staff members): the design's list of staff members, each row opening the
// member's grants, then the pager. Inviting a staff member waits for
// decisions (A5, A3) and is shown as not available yet.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveCapabilityAdministration } from "../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import {
  Cell,
  Empty,
  ListBox,
  ListRow,
  NotAvailableYet,
  Panel,
  PillCell,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { PagerLinks, refusalPage, StaffFrame } from "../frame.tsx";

export const metadata: Metadata = {
  title: "Staff capabilities",
  robots: { index: false, follow: false },
};

const COLUMNS = ["Staff member", "Account", "Staff profile"] as const;

export default async function CapabilitiesPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string | string[] }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { page } = await searchParams;
  const view = await resolveCapabilityAdministration(
    STAFF_CONFIGURATION_SOURCES,
    page,
  );
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/capabilities", "Staff capabilities");
  }
  return (
    <StaffFrame
      title="Staff"
      subtitle="Staff members and the capabilities granted to them."
      lead={
        <p>
          A staff profile alone grants nothing. Each capability is a separate
          grant, for all jurisdictions or one, and can expire or be revoked.
        </p>
      }
    >
      <ListBox label="Staff members" columns={COLUMNS}>
        {view.members.length === 0 ? (
          <Empty title="There are no staff members on this page." />
        ) : (
          view.members.map((member) => (
            <ListRow
              key={member.userId}
              href={`/staff/capabilities/${member.userId}`}
              columns={3}
            >
              <Cell label="Staff member" strong>
                {member.isYou ? `${member.name} (you)` : member.name}
              </Cell>
              <Cell label="Account">{member.accountState}</Cell>
              <PillCell
                label="Staff profile"
                tone={member.staffState === "active" ? "success" : "neutral"}
              >
                {member.staffState}
              </PillCell>
            </ListRow>
          ))
        )}
      </ListBox>
      <PagerLinks
        pager={view.pager}
        base="/staff/capabilities"
        noun="staff members"
        shown={view.members.length}
      />
      <Panel id="staff-invite-title" title="Invite a staff member">
        <NotAvailableYet
          what={["Invite a staff member"]}
          reason="who may invite staff members, and how an invitation is approved, wait for decisions. Staff membership is never self-service."
        />
      </Panel>
    </StaffFrame>
  );
}
