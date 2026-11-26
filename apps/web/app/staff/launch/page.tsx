// Launch gates and authorization: jurisdictions (MVP-001 S1).
//
// Rendered on the server for every request. A fresh staff identity and the
// database's own capability predicate decide access: the jurisdiction-
// configuration or the launch-authorization capability, in some scope. The
// jurisdictions listed are only those the caller's own session may read
// under the row policies, one page at a time, by code. The one query value
// read, page, only asks which page to show; the server checks it.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Platform › Marketplace):
// the design's list of jurisdictions, each row opening its launch record.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveLaunchList } from "../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import { LIFECYCLE_LABELS } from "../../../src/presentation/staff-configuration-labels.ts";
import {
  Cell,
  Empty,
  ListBox,
  ListRow,
  PillCell,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { PagerLinks, refusalPage, StaffFrame } from "../frame.tsx";

export const metadata: Metadata = {
  title: "Launch gates and authorization",
  robots: { index: false, follow: false },
};

const COLUMNS = ["Jurisdiction", "Lifecycle"] as const;

export default async function LaunchPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string | string[] }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { page } = await searchParams;
  const view = await resolveLaunchList(STAFF_CONFIGURATION_SOURCES, page);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/launch", "Launch gates and authorization");
  }
  return (
    <StaffFrame
      title="Marketplace"
      subtitle="Launch gates and authorization, by jurisdiction."
      lead={
        <p>
          A jurisdiction becomes live only when every required launch
          gate&apos;s latest evaluation has passed and a staff member has
          recorded a launch authorization. Neither alone makes it live.
        </p>
      }
    >
      <ListBox label="Jurisdictions, by code" columns={COLUMNS} sub>
        {view.jurisdictions.length === 0 && view.pager.page === 1 ? (
          <Empty title="There are no jurisdictions you can read yet." />
        ) : null}
        {view.jurisdictions.map((j) => (
          <ListRow key={j.id} href={`/staff/launch/${j.id}`} columns={2} sub>
            <Cell label="Jurisdiction" strong>
              {j.name}
            </Cell>
            <Cell label="">{j.code}</Cell>
            <PillCell label="Lifecycle" tone={LIFECYCLE_LABELS[j.state].tone}>
              {LIFECYCLE_LABELS[j.state].label}
            </PillCell>
          </ListRow>
        ))}
      </ListBox>
      <PagerLinks
        pager={view.pager}
        base="/staff/launch"
        noun="jurisdictions"
        shown={view.jurisdictions.length}
      />
    </StaffFrame>
  );
}
