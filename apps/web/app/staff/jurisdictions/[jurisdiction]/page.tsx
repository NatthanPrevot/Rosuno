// One jurisdiction: lifecycle and service areas (MVP-001 S1).
//
// Rendered on the server for every request. The route segment only names
// which jurisdiction to look at: a fresh staff identity and the database's
// own capability predicate for exactly that jurisdiction decide access, and
// a jurisdiction the caller's session cannot read looks exactly like one
// that does not exist. LIVE is decided by the database from the launch gates
// and the human launch authorization.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, the Marketplace record):
// the design's record panel with the lifecycle pill, the jurisdiction, its
// lifecycle form, the link to its launch gates and its service areas.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveJurisdiction } from "../../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import { Disclosure } from "../../../../src/presentation/design-system.tsx";
import {
  LIFECYCLE_LABELS,
  periodLabel,
} from "../../../../src/presentation/staff-configuration-labels.ts";
import {
  Block,
  KeyValues,
  RecordPanel,
} from "../../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../../account/gate.ts";
import { BoundNotice, refusalPage } from "../../frame.tsx";
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
  await requireSteppedUp("staff");
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
    <RecordPanel
      titleId="staff-configuration-title"
      title={`${j.name} (${j.code})`}
      sub="Jurisdiction"
      pill={{
        tone: LIFECYCLE_LABELS[j.state].tone,
        label: LIFECYCLE_LABELS[j.state].label,
      }}
      back={{ href: "/staff/jurisdictions", label: "Back to jurisdictions" }}
    >
      <Block title="Jurisdiction">
        <KeyValues
          items={[
            ["Code", j.code],
            ["Region type", j.regionType],
            ["Lifecycle", LIFECYCLE_LABELS[j.state].label],
          ]}
        />
        <Disclosure summary="Change the lifecycle state">
          <LifecycleForm
            jurisdiction={j.id}
            expectedUpdatedAt={j.updatedAt}
            targets={view.targets}
          />
        </Disclosure>
        <div className="st-links">
          <a className="btn btn-line btn-sm" href={`/staff/launch/${j.id}`}>
            Launch gates and authorization
          </a>
        </div>
      </Block>
      <Block title="Service areas">
        <BoundNotice
          complete={view.serviceAreasComplete}
          noun="service areas"
        />
        {view.serviceAreas.length === 0 ? (
          <p className="st-emd">No service area is recorded.</p>
        ) : (
          <KeyValues
            items={view.serviceAreas.map(
              (area) =>
                [
                  `${area.name} (${area.code})`,
                  periodLabel(area.activeFrom, area.activeUntil),
                ] as const,
            )}
          />
        )}
        <Disclosure summary="Add a service area">
          <ServiceAreaForm jurisdiction={j.id} />
        </Disclosure>
      </Block>
    </RecordPanel>
  );
}
