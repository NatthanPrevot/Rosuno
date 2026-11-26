// The staff workspace frame (DEV-001: the owner's UI/UX design,
// UIUX-HANDOFF-P2 build_p8, Staff.dc.html, Admin 1B).
//
// Rendered on the server for every request. The step-up gate comes first,
// then the staff home's own use case answers which staff surfaces the caller
// holds; the sidebar lists only the destinations holding one of them. The
// navigation is presentation only: every staff page decides access again
// for itself (its own use case, its own step-up gate), so a destination left
// out here is never the only thing keeping a page closed, and a destination
// shown here never opens a page the caller does not hold. A caller the staff
// home does not admit sees the frame without any navigation. The layout
// reads no route parameter, query, header or cookie of its own.

import { connection } from "next/server";
import type { ReactNode } from "react";

import { resolveStaffHome } from "../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../src/infrastructure/staff/staff-configuration-adapter.ts";
import { StaffShell } from "../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../account/gate.ts";
import { StaffNavigation, StaffViews } from "./navigation.tsx";

export default async function StaffLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const home = await resolveStaffHome(STAFF_CONFIGURATION_SOURCES);
  if (home.status !== "ready") {
    return (
      <StaffShell navigation={null} views={null}>
        {children}
      </StaffShell>
    );
  }
  return (
    <StaffShell
      navigation={<StaffNavigation surfaces={home.surfaces} />}
      views={<StaffViews surfaces={home.surfaces} />}
    >
      {children}
    </StaffShell>
  );
}
