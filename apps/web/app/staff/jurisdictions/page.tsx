// Jurisdictions (MVP-001 S1).
//
// Rendered on the server for every request. A fresh staff identity and the
// database's own capability predicate decide access; the jurisdictions listed
// are only those the caller's own session may read under the row policies,
// one page at a time, by code. The one query value read, page, only asks
// which page to show; the server checks it. Creating a jurisdiction is
// offered only with the global jurisdiction-configuration grant, and a new
// jurisdiction is never live.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveJurisdictionList } from "../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import {
  ButtonLink,
  Disclosure,
  Status,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import { LIFECYCLE_LABELS } from "../../../src/presentation/staff-configuration-labels.ts";
import { BackLink, PagerLinks, refusalPage, StaffFrame } from "../frame.tsx";
import { CreateJurisdictionForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Jurisdictions",
  robots: { index: false, follow: false },
};

export default async function JurisdictionsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string | string[] }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const { page } = await searchParams;
  const view = await resolveJurisdictionList(STAFF_CONFIGURATION_SOURCES, page);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/jurisdictions", "Jurisdictions");
  }
  return (
    <StaffFrame eyebrow="Staff configuration" title="Jurisdictions">
      <BackLink href="/staff">Staff tools</BackLink>
      {view.jurisdictions.length === 0 && view.pager.page === 1 ? (
        <Text>There are no jurisdictions you can read yet.</Text>
      ) : null}
      {view.jurisdictions.length === 0 ? null : (
        <Table id="jurisdictions" caption="Jurisdictions, by code">
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Name</th>
              <th scope="col">Region type</th>
              <th scope="col">Lifecycle</th>
              <th scope="col">Open</th>
            </tr>
          </thead>
          <tbody>
            {view.jurisdictions.map((j) => (
              <tr key={j.id}>
                <td>{j.code}</td>
                <td>{j.name}</td>
                <td>{j.regionType}</td>
                <td>
                  <Status tone={LIFECYCLE_LABELS[j.state].tone}>
                    {LIFECYCLE_LABELS[j.state].label}
                  </Status>
                </td>
                <td>
                  <ButtonLink
                    variant="tertiary"
                    href={`/staff/jurisdictions/${j.id}`}
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
        base="/staff/jurisdictions"
        noun="jurisdictions"
        shown={view.jurisdictions.length}
      />
      {view.canCreate ? (
        <Disclosure summary="Create a jurisdiction">
          <CreateJurisdictionForm />
        </Disclosure>
      ) : (
        <Text tone="muted">
          Creating a jurisdiction needs the jurisdiction-configuration
          capability for all jurisdictions.
        </Text>
      )}
    </StaffFrame>
  );
}
