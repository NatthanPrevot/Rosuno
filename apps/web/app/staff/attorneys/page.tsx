// Attorneys: the staff list of attorney profiles by stage (DEV-001: the
// owner's UI/UX design, UIUX-HANDOFF-P2 build_p8, Staff.dc.html, People ›
// Attorneys).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); the page then asks the existing compliance workspace use case
// (staff_compliance_records through the operations adapter), which lists the
// attorney records only to holders of manage_attorney_verification in some
// scope, and the database scopes every row by jurisdiction. A caller the use
// case refuses, or one whose grants do not include the attorney records,
// sees the fixed refusal and no record. One page of profiles at one stage
// (under review, approved, suspended or removed), each opening the
// attorney's lifecycle page for holders of the global grant that page
// requires (a plain row otherwise). The two query values read, section and
// page, only choose the stage and the page; a section that is not a profile
// stage shows the first stage.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveComplianceWorkspace } from "../../../src/application/administration-workspace.ts";
import { ADMINISTRATION_SOURCES } from "../../../src/infrastructure/staff/operations-adapter.ts";
import {
  COMPLIANCE_SECTION_LABELS,
  COMPLIANCE_SECTION_NOTES,
  PROFILE_STAGE_LABELS,
  utcText,
} from "../../../src/presentation/operations-labels.ts";
import {
  Cell,
  Empty,
  ListBox,
  ListRow,
  PagerRow,
  PillCell,
  TabLinks,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { refusalPage, StaffFrame } from "../frame.tsx";

export const metadata: Metadata = {
  title: "Attorneys",
  robots: { index: false, follow: false },
};

// The attorney profile stages of the compliance workspace's sections.
const STAGES = ["under_review", "approved", "suspended", "removed"] as const;

// A profile stage answers no jurisdiction; its time is the profile's last
// change.
const COLUMNS = ["Attorney", "Last changed (UTC)", "Stage"];

export default async function AttorneysPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly section?: string | string[];
    readonly page?: string | string[];
  }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { section, page } = await searchParams;
  const workspace = await resolveComplianceWorkspace(
    ADMINISTRATION_SOURCES,
    STAGES.some((stage) => stage === section) ? section : undefined,
    page,
  );
  if (workspace.status !== "ready") {
    return refusalPage(workspace, "/staff/attorneys", "Attorneys");
  }
  // The attorney records are the page: without them (not held, or not
  // readable right now) nothing of the workspace is shown.
  if (workspace.sections.records !== "ready") {
    return refusalPage(
      {
        status:
          workspace.sections.records === "not_held" ? "denied" : "unavailable",
      },
      "/staff/attorneys",
      "Attorneys",
    );
  }
  const records = workspace.records ?? [];
  const pager = workspace.pager ?? { page: 1, hasNext: false };
  const base = `/staff/attorneys?section=${workspace.section}`;
  return (
    <StaffFrame
      title="Attorneys"
      description="Attorney profiles by stage, in your scope."
      lead={
        <p>
          Each status is separate. A profile stage does not verify credentials,
          authorize a practice area or make an attorney eligible.
        </p>
      }
      utc
    >
      <TabLinks
        label="Attorney profiles by stage"
        links={STAGES.map((stage) => ({
          href: `/staff/attorneys?section=${stage}`,
          label: COMPLIANCE_SECTION_LABELS[stage],
        }))}
        current={base}
      />
      <p className="st-emd">{COMPLIANCE_SECTION_NOTES[workspace.section]}</p>
      <ListBox
        label={COMPLIANCE_SECTION_LABELS[workspace.section]}
        columns={COLUMNS}
      >
        {records.length === 0 ? (
          <Empty
            title={
              pager.page === 1
                ? "There is nothing in this section."
                : "There is nothing on this page."
            }
          />
        ) : (
          records.map((record) => {
            const stage = PROFILE_STAGE_LABELS[record.profileState];
            return (
              <ListRow
                key={`${record.recordType}-${record.recordId}`}
                href={
                  workspace.attorneyPages
                    ? `/staff/attorneys/${record.attorneyId}`
                    : undefined
                }
                columns={3}
              >
                <Cell label="Attorney" strong>
                  {record.displayName ?? "No name recorded"}
                </Cell>
                <Cell label="Last changed">
                  {record.recordedAt === null
                    ? "Not recorded"
                    : utcText(record.recordedAt)}
                </Cell>
                <PillCell label="Stage" tone={stage.tone}>
                  {stage.label}
                </PillCell>
              </ListRow>
            );
          })
        )}
      </ListBox>
      {workspace.attorneyPages ? null : (
        <p className="st-emd">
          An attorney&apos;s own page needs verification access for every
          jurisdiction, so the rows above do not open one.
        </p>
      )}
      {pager.page === 1 && !pager.hasNext ? null : (
        <PagerRow
          note={`Page ${pager.page} of this stage.`}
          previous={pager.page > 1 ? `${base}&page=${pager.page - 1}` : null}
          next={pager.hasNext ? `${base}&page=${pager.page + 1}` : null}
        />
      )}
    </StaffFrame>
  );
}
