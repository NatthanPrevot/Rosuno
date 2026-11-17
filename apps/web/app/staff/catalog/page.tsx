// Practice-area catalog (MVP-001 S1).
//
// Rendered on the server for every request. A fresh staff identity and the
// database's own capability predicate decide access: the catalog needs the
// jurisdiction-configuration capability for all jurisdictions, exactly as its
// row policy and its functions do. Practice areas are listed one page at a
// time, by code. The one query value read, page, only asks which page to
// show; the server checks it.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveCatalog } from "../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import {
  Disclosure,
  Status,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { BackLink, PagerLinks, refusalPage, StaffFrame } from "../frame.tsx";
import { CreatePracticeAreaForm, PracticeAreaActivityForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Practice-area catalog",
  robots: { index: false, follow: false },
};

export default async function CatalogPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string | string[] }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const { page } = await searchParams;
  const view = await resolveCatalog(STAFF_CONFIGURATION_SOURCES, page);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/catalog", "Practice-area catalog");
  }
  return (
    <StaffFrame eyebrow="Staff configuration" title="Practice-area catalog">
      <BackLink href="/staff">Staff tools</BackLink>
      {view.areas.length === 0 && view.pager.page === 1 ? (
        <Text>There are no practice areas yet.</Text>
      ) : null}
      {view.areas.length === 0 ? null : (
        <Table id="practice-areas" caption="Practice areas, by code">
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Name</th>
              <th scope="col">Status</th>
              <th scope="col">Change</th>
            </tr>
          </thead>
          <tbody>
            {view.areas.map((area) => (
              <tr key={area.id}>
                <td>{area.code}</td>
                <td>{area.name}</td>
                <td>
                  <Status tone={area.active ? "success" : "neutral"}>
                    {area.active ? "Active" : "Inactive"}
                  </Status>
                </td>
                <td>
                  <PracticeAreaActivityForm
                    area={area.id}
                    active={area.active}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <PagerLinks
        pager={view.pager}
        base="/staff/catalog"
        noun="practice areas"
        shown={view.areas.length}
      />
      <Disclosure summary="Add a practice area">
        <CreatePracticeAreaForm />
      </Disclosure>
    </StaffFrame>
  );
}
