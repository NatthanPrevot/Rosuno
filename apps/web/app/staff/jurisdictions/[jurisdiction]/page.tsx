// One jurisdiction: lifecycle and service areas (MVP-001 S1).
//
// Rendered on the server for every request. The route segment only names
// which jurisdiction to look at: a fresh staff identity and the database's
// own capability predicate for exactly that jurisdiction decide access, and
// a jurisdiction the caller's session cannot read looks exactly like one
// that does not exist. LIVE is decided by the database from the launch gates
// and the human launch authorization.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveJurisdiction } from "../../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import {
  ButtonLink,
  Cluster,
  Disclosure,
  Heading,
  Status,
  Table,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import {
  LIFECYCLE_LABELS,
  periodLabel,
} from "../../../../src/presentation/staff-configuration-labels.ts";
import {
  BackLink,
  BoundNotice,
  refusalPage,
  StaffFrame,
} from "../../frame.tsx";
import { LifecycleForm, ServiceAreaForm } from "../forms.tsx";

export const metadata: Metadata = {
  title: "Jurisdiction",
  robots: { index: false, follow: false },
};

export default async function JurisdictionPage({
  params,
}: {
  readonly params: Promise<{ readonly jurisdiction: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  const { jurisdiction } = await params;
  const view = await resolveJurisdiction(
    STAFF_CONFIGURATION_SOURCES,
    jurisdiction,
  );
  if (view.status !== "ready") {
    return refusalPage(
      view,
      "/staff/jurisdictions/[jurisdiction]",
      "Jurisdiction",
    );
  }
  const j = view.jurisdiction;
  return (
    <StaffFrame eyebrow="Staff configuration" title={`${j.name} (${j.code})`}>
      <BackLink href="/staff/jurisdictions">Back to jurisdictions</BackLink>
      <Table id="jurisdiction" caption="Jurisdiction">
        <tbody>
          <tr>
            <th scope="row">Code</th>
            <td>{j.code}</td>
          </tr>
          <tr>
            <th scope="row">Region type</th>
            <td>{j.regionType}</td>
          </tr>
          <tr>
            <th scope="row">Lifecycle</th>
            <td>
              <Status tone={LIFECYCLE_LABELS[j.state].tone}>
                {LIFECYCLE_LABELS[j.state].label}
              </Status>
            </td>
          </tr>
        </tbody>
      </Table>
      <Disclosure summary="Change the lifecycle state">
        <LifecycleForm
          jurisdiction={j.id}
          expectedUpdatedAt={j.updatedAt}
          targets={view.targets}
        />
      </Disclosure>
      <Cluster>
        <ButtonLink variant="secondary" href={`/staff/launch/${j.id}`}>
          Launch gates and authorization
        </ButtonLink>
      </Cluster>
      <Heading as="h2" size="md">
        Service areas
      </Heading>
      <BoundNotice complete={view.serviceAreasComplete} noun="service areas" />
      {view.serviceAreas.length === 0 ? (
        <Text tone="muted">No service area is recorded.</Text>
      ) : (
        <Table id="service-areas" caption="Service areas, by code">
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Name</th>
              <th scope="col">Active</th>
            </tr>
          </thead>
          <tbody>
            {view.serviceAreas.map((area) => (
              <tr key={area.id}>
                <td>{area.code}</td>
                <td>{area.name}</td>
                <td>{periodLabel(area.activeFrom, area.activeUntil)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Disclosure summary="Add a service area">
        <ServiceAreaForm jurisdiction={j.id} />
      </Disclosure>
    </StaffFrame>
  );
}
