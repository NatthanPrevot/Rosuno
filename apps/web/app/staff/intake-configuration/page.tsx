// Intake configuration (MVP-001 S1).
//
// Rendered on the server for every request. A fresh staff identity and the
// database's own capability predicate decide access: publishing needs the
// manage_intake_configuration capability for all jurisdictions, exactly as
// the publishing function does. Published versions are listed one page at a
// time, newest first; the newest is the current one. The one query value
// read, page, only asks which page to show; the server checks it. MVP-001
// S3 part 2: the page also says whether the current version asks for the
// category that routes an Intake; question sets stay one platform-wide
// sequence (PS-A1 section 1.8), so no version is tied to a category.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Platform › Marketplace,
// forms and intake): the design's list of published versions, then the
// category routing note and the publishing form in a panel.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveIntakeConfiguration } from "../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import { Disclosure } from "../../../src/presentation/design-system.tsx";
import { utcDateTime } from "../../../src/presentation/staff-configuration-labels.ts";
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
import { PublishQuestionSetForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Intake configuration",
  robots: { index: false, follow: false },
};

const COLUMNS = ["Version key", "Published", "Questions", "Status"] as const;

export default async function IntakeConfigurationPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string | string[] }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { page } = await searchParams;
  const view = await resolveIntakeConfiguration(
    STAFF_CONFIGURATION_SOURCES,
    page,
  );
  if (view.status !== "ready") {
    return refusalPage(
      view,
      "/staff/intake-configuration",
      "Intake configuration",
    );
  }
  return (
    <StaffFrame
      title="Marketplace"
      subtitle="Forms & intake: the published question-set versions."
      utc
    >
      <ListBox label="Published versions, newest first" columns={COLUMNS}>
        {view.versions.length === 0 && view.pager.page === 1 ? (
          <Empty title="No question-set version is published yet." />
        ) : null}
        {view.versions.map((version) => (
          <ListRow key={version.id} columns={4}>
            <Cell label="Version key" strong>
              {version.versionKey}
            </Cell>
            <Cell label="Published">{utcDateTime(version.publishedAt)}</Cell>
            <Cell label="Questions">{version.questions}</Cell>
            {version.versionKey === view.currentVersionKey ? (
              <PillCell label="Status" tone="success">
                Current
              </PillCell>
            ) : (
              <PillCell label="Status" tone="neutral">
                Earlier version
              </PillCell>
            )}
          </ListRow>
        ))}
      </ListBox>
      <PagerLinks
        pager={view.pager}
        base="/staff/intake-configuration"
        noun="versions"
        shown={view.versions.length}
      />
      {view.currentAsksCategory === null ? null : (
        <p className="st-emd">
          {view.currentAsksCategory
            ? "Category routing: the current version asks for a practice area. An Intake's category is the practice area its client saves; a missing or not-sure answer stays unresolved and is never guessed."
            : "Category routing: the current version asks for no practice area, so Intakes answered under it carry no category."}
        </p>
      )}
      <Panel id="intake-publish-title" title="Publish a new version">
        <p className="st-emd">
          {view.currentVersionKey === null
            ? "Enter the complete definition of the first version."
            : `The form starts from the current version (${view.currentVersionKey}). Publishing makes the new version current; clients keep their saved answers and review them under it.`}
        </p>
        <Disclosure summary="Publish a question-set version">
          <PublishQuestionSetForm
            definitionText={view.currentDefinitionText ?? ""}
          />
        </Disclosure>
      </Panel>
    </StaffFrame>
  );
}
