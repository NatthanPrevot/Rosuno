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

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveStaffHome } from "../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../src/infrastructure/staff/staff-configuration-adapter.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Heading,
  Stack,
  Surface,
  Text,
} from "../../src/presentation/design-system.tsx";
import {
  SURFACE_AREAS,
  SURFACE_LINKS,
} from "../../src/presentation/staff-configuration-labels.ts";
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
    <StaffFrame eyebrow="Staff" title="Staff tools">
      {view.surfaces.length === 0 ? (
        <Alert
          tone="information"
          title="No staff tools available"
          role="status"
        >
          This account does not hold a current capability for any staff tool. A
          staff profile alone grants none.
        </Alert>
      ) : (
        <Stack>
          {SURFACE_AREAS.map((area) => {
            const held = area.surfaces.filter((surface) =>
              view.surfaces.includes(surface),
            );
            if (held.length === 0) {
              return null;
            }
            return (
              <Stack key={area.id} gap="tight">
                <Heading as="h2" size="md" id={`staff-area-${area.id}`}>
                  {area.title}
                </Heading>
                {held.map((surface) => {
                  const link = SURFACE_LINKS[surface];
                  return (
                    <Surface
                      key={surface}
                      labelledBy={`staff-surface-${surface}`}
                    >
                      <Stack gap="tight">
                        <Heading
                          as="h3"
                          size="sm"
                          id={`staff-surface-${surface}`}
                        >
                          {link.title}
                        </Heading>
                        <Text tone="muted">{link.summary}</Text>
                        <Cluster>
                          <ButtonLink variant="secondary" href={link.href}>
                            {`Open ${link.title.toLowerCase()}`}
                          </ButtonLink>
                        </Cluster>
                      </Stack>
                    </Surface>
                  );
                })}
              </Stack>
            );
          })}
        </Stack>
      )}
    </StaffFrame>
  );
}
