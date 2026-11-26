// Staff tools (MVP-001 S1).
//
// Rendered on the server for every request. A fresh staff identity and the
// database's own capability predicate decide which staff surfaces are
// listed: only those the caller holds a current grant for. The page only
// links to surfaces; each surface decides access again for itself and
// offers no action the caller cannot run. It reads no route parameter,
// query, header, or cookie of its own. MVP-001 S11 pass 2: the links are
// grouped by area (operations, attorneys, policy and launch, security and
// audit, clients, referrals, compliance, finance, system health); an area
// whose surfaces the caller holds none of is not shown.
//
// DEV-001: the owner's UI/UX design (UIUX-HANDOFF-P2 build_p8, Staff.dc.html,
// the Dashboard): each area is one of the design's panels listing the staff
// tools the caller holds as its task rows. No figure is shown here: the
// page reads no count, and the design's sample figures are not shipped.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveStaffHome } from "../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../src/infrastructure/staff/staff-configuration-adapter.ts";
import {
  SURFACE_AREAS,
  SURFACE_LINKS,
} from "../../src/presentation/staff-configuration-labels.ts";
import {
  Empty,
  Panel,
  PanelGrid,
  Task,
  TaskList,
} from "../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../account/gate.ts";
import { refusalPage, StaffFrame } from "./frame.tsx";

export const metadata: Metadata = {
  title: "Staff tools",
  robots: { index: false, follow: false },
};

export default async function StaffHomePage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const view = await resolveStaffHome(STAFF_CONFIGURATION_SOURCES);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff", "Staff tools");
  }
  return (
    <StaffFrame
      title="Dashboard"
      subtitle="The staff tools your current grants open, by area."
    >
      {view.surfaces.length === 0 ? (
        <section className="w-card st-panel" role="status">
          <Empty
            title="No staff tools available"
            note="This account does not hold a current capability for any staff tool. A staff profile alone grants none."
          />
        </section>
      ) : (
        <PanelGrid>
          {SURFACE_AREAS.map((area) => {
            const held = area.surfaces.filter((surface) =>
              view.surfaces.includes(surface),
            );
            if (held.length === 0) {
              return null;
            }
            return (
              <Panel
                key={area.id}
                id={`staff-area-${area.id}`}
                title={area.title}
                place="s6"
              >
                <TaskList>
                  {held.map((surface) => {
                    const link = SURFACE_LINKS[surface];
                    return (
                      <Task
                        key={surface}
                        href={link.href}
                        title={link.title}
                        description={link.summary}
                      />
                    );
                  })}
                </TaskList>
              </Panel>
            );
          })}
        </PanelGrid>
      )}
    </StaffFrame>
  );
}
