// Practice-area catalog (MVP-001 S1).
//
// Rendered on the server for every request. A fresh staff identity and the
// database's own capability predicate decide access: the catalog needs the
// jurisdiction-configuration capability for all jurisdictions, exactly as its
// row policy and its functions do. Practice areas are listed one page at a
// time, by code. The one query value read, page, only asks which page to
// show; the server checks it.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Platform › Marketplace,
// practice areas): the design's list, each row holding its activity form,
// then the pager and the creation form.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveCatalog } from "../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import { Disclosure } from "../../../src/presentation/design-system.tsx";
import {
  ActionCell,
  Cell,
  Empty,
  ListBox,
  ListRow,
  Panel,
  PillCell,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { PagerLinks, refusalPage, StaffFrame } from "../frame.tsx";
import { CreatePracticeAreaForm, PracticeAreaActivityForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Practice-area catalog",
  robots: { index: false, follow: false },
};

const COLUMNS = ["Practice area", "Status", "Change"] as const;

export default async function CatalogPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string | string[] }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { page } = await searchParams;
  const view = await resolveCatalog(STAFF_CONFIGURATION_SOURCES, page);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/catalog", "Practice-area catalog");
  }
  return (
    <StaffFrame
      title="Marketplace"
      subtitle="Practice areas in the catalog, active or inactive."
    >
      <ListBox label="Practice areas, by code" columns={COLUMNS} sub>
        {view.areas.length === 0 && view.pager.page === 1 ? (
          <Empty title="There are no practice areas yet." />
        ) : null}
        {view.areas.map((area) => (
          <ListRow key={area.id} columns={3} sub>
            <Cell label="Practice area" strong>
              {area.name}
            </Cell>
            <Cell label="">{area.code}</Cell>
            <PillCell label="Status" tone={area.active ? "success" : "neutral"}>
              {area.active ? "Active" : "Inactive"}
            </PillCell>
            <ActionCell>
              <PracticeAreaActivityForm area={area.id} active={area.active} />
            </ActionCell>
          </ListRow>
        ))}
      </ListBox>
      <PagerLinks
        pager={view.pager}
        base="/staff/catalog"
        noun="practice areas"
        shown={view.areas.length}
      />
      <Panel id="catalog-create-title" title="Add a practice area">
        <Disclosure summary="Add a practice area">
          <CreatePracticeAreaForm />
        </Disclosure>
      </Panel>
    </StaffFrame>
  );
}
