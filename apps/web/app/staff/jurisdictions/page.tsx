// Jurisdictions (MVP-001 S1).
//
// Rendered on the server for every request. A fresh staff identity and the
// database's own capability predicate decide access; the jurisdictions listed
// are only those the caller's own session may read under the row policies,
// one page at a time, by code. The one query value read, page, only asks
// which page to show; the server checks it. Creating a jurisdiction is
// offered only with the global jurisdiction-configuration grant, and a new
// jurisdiction is never live.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Platform › Marketplace):
// the design's list of jurisdictions, each row opening its record, then the
// pager and the creation form.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveJurisdictionList } from "../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import { Disclosure } from "../../../src/presentation/design-system.tsx";
import { LIFECYCLE_LABELS } from "../../../src/presentation/staff-configuration-labels.ts";
import {
  Cell,
  Empty,
  ListBox,
  ListRow,
  Panel,
  PillCell,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { PagerLinks, refusalPage, StaffFrame } from "../frame.tsx";
import { CreateJurisdictionForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Jurisdictions",
  robots: { index: false, follow: false },
};

const COLUMNS = ["Jurisdiction", "Region type", "Lifecycle"] as const;

export default async function JurisdictionsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string | string[] }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { page } = await searchParams;
  const view = await resolveJurisdictionList(STAFF_CONFIGURATION_SOURCES, page);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/jurisdictions", "Jurisdictions");
  }
  return (
    <StaffFrame
      title="Marketplace"
      subtitle="Jurisdictions: their lifecycle and service areas."
    >
      <ListBox label="Jurisdictions, by code" columns={COLUMNS} sub>
        {view.jurisdictions.length === 0 && view.pager.page === 1 ? (
          <Empty title="There are no jurisdictions you can read yet." />
        ) : null}
        {view.jurisdictions.map((j) => (
          <ListRow
            key={j.id}
            href={`/staff/jurisdictions/${j.id}`}
            columns={3}
            sub
          >
            <Cell label="Jurisdiction" strong>
              {j.name}
            </Cell>
            <Cell label="">{j.code}</Cell>
            <Cell label="Region type">{j.regionType}</Cell>
            <PillCell label="Lifecycle" tone={LIFECYCLE_LABELS[j.state].tone}>
              {LIFECYCLE_LABELS[j.state].label}
            </PillCell>
          </ListRow>
        ))}
      </ListBox>
      <PagerLinks
        pager={view.pager}
        base="/staff/jurisdictions"
        noun="jurisdictions"
        shown={view.jurisdictions.length}
      />
      <Panel id="jurisdiction-create-title" title="Create a jurisdiction">
        {view.canCreate ? (
          <Disclosure summary="Create a jurisdiction">
            <CreateJurisdictionForm />
          </Disclosure>
        ) : (
          <p className="st-emd">
            Creating a jurisdiction needs the jurisdiction-configuration
            capability for all jurisdictions.
          </p>
        )}
      </Panel>
    </StaffFrame>
  );
}
