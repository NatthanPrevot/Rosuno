// Compliance workspace (MVP-001 S11; PS section 30.4; TA sections 18 and 41;
// PM rows 37 to 46; MBS section 18.4 "attorney compliance; licenses;
// insurance; discipline; complaints"; MB sections 19, 22 and 81 to 90).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2). MVP-001 S11 pass 2: each section is shown only to holders of its
// own capability, and a caller holding none of them is refused (the
// database decides every row again):
// - attorney records (manage_attorney_verification, by jurisdiction):
//   applications under review, approved, suspended and removed profiles,
//   licence and insurance end dates, evidence age against the eligibility
//   policy in force, discipline records and the attorney waitlist; each
//   profile links to its lifecycle page (which links its verification
//   record) for holders of the global grant that page requires (plain text
//   otherwise);
// - the compliance family's review items (the global manage_compliance_reviews
//   grant): eligibility and jurisdiction change reviews, rejoin reviews and
//   client account reviews, listed one page at a time, open or resolved; an
//   open item can be assigned to oneself, have its assignment cleared, or be
//   resolved once with notes; each change is audited;
// - reported problems by state (manage_complaints), recent policy version
//   status changes (manage_policy_configuration) and Legal Holds in force
//   (manage_legal_holds).
// Each optional section (the attorney records, the review items, the policy
// status changes) that cannot be read right now is shown as unavailable while
// the rest of the page is shown; a refusal still refuses the page.
// Panels, surveys, referral quality and other regulatory-mode-conditional
// sections are not presented. The query values read, status and page (the
// review items) and section and records (the attorney records), only choose
// the lists and their pages.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Applications &
// verification › Compliance review): the design's count panels (exact counts
// the summary answered), the attorney records as the design's list with its
// section tabs, the compliance review items and the recent policy status
// changes.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  COMPLIANCE_SECTIONS,
  resolveComplianceWorkspace,
} from "../../../src/application/administration-workspace.ts";
import { resolveFamilyExceptions } from "../../../src/application/consultation-outcomes.ts";
import { jurisdictionLabel } from "../../../src/application/operations-workspace.ts";
import { OPERATIONS_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { ADMINISTRATION_SOURCES } from "../../../src/infrastructure/staff/operations-adapter.ts";
import { ButtonLink } from "../../../src/presentation/design-system.tsx";
import {
  COMPLIANCE_COUNT_TITLES,
  COMPLIANCE_DIMENSION_LABELS,
  COMPLIANCE_INTRO,
  COMPLIANCE_SECTION_LABELS,
  COMPLIANCE_SECTION_NOTES,
  POLICY_STATUS_TEXT,
  PROFILE_STAGE_LABELS,
  utcText,
} from "../../../src/presentation/operations-labels.ts";
import {
  ActionCell,
  Cell,
  Empty,
  ListBox,
  ListRow,
  PagerRow,
  Panel,
  PanelGrid,
  PillCell,
  TabLinks,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { refusalPage, StaffFrame } from "../frame.tsx";
import { ReviewItemList } from "../review-item-list.tsx";
import {
  assignComplianceItemAction,
  resolveComplianceItemAction,
} from "./actions.ts";

export const metadata: Metadata = {
  title: "Compliance review items",
  robots: { index: false, follow: false },
};

const COUNT_GROUPS = [
  "attorney_profiles",
  "waitlist",
  "compliance_reviews",
  "complaints",
  "legal_holds",
] as const;

const RECORD_COLUMNS = [
  "Attorney",
  "Jurisdiction",
  "Recorded (UTC)",
  "Date",
  "Stage",
  "Open",
] as const;

const CHANGE_COLUMNS = [
  "When (UTC)",
  "Policy type",
  "Scope",
  "From",
  "To",
] as const;

export default async function ComplianceItemsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly status?: string | string[];
    readonly page?: string | string[];
    readonly section?: string | string[];
    readonly records?: string | string[];
  }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { status, page, section, records } = await searchParams;
  const workspace = await resolveComplianceWorkspace(
    ADMINISTRATION_SOURCES,
    section,
    records,
  );
  if (workspace.status !== "ready") {
    return refusalPage(workspace, "/staff/compliance", "Compliance");
  }
  const view = workspace.held.reviews
    ? await resolveFamilyExceptions(
        OPERATIONS_SOURCES,
        "compliance",
        status,
        page,
      )
    : null;
  // A refusal of the review items refuses the page; review items that cannot
  // be read right now are shown as unavailable in their own section.
  if (
    view !== null &&
    view.status !== "ready" &&
    view.status !== "unavailable"
  ) {
    return refusalPage(view, "/staff/compliance", "Compliance");
  }
  const recordsBase = `/staff/compliance?section=${workspace.section}`;
  const groups = COUNT_GROUPS.filter(
    (group) => workspace.counts[group] !== undefined,
  );
  return (
    <StaffFrame
      title="Applications & verification"
      subtitle="Compliance: attorney records, review items and policy status changes."
      lead={<p>{COMPLIANCE_INTRO}</p>}
      utc
    >
      {groups.length === 0 ? null : (
        <PanelGrid>
          {groups.map((group) => (
            <Panel
              key={group}
              id={`compliance-counts-${group}-title`}
              title={COMPLIANCE_COUNT_TITLES[group]}
              place="s6"
            >
              <table className="st-cov" id={`compliance-counts-${group}`}>
                <caption>{COMPLIANCE_COUNT_TITLES[group]}</caption>
                <tbody>
                  {workspace.counts[group].map((count) => (
                    <tr key={count.dimension}>
                      <th scope="row">
                        {COMPLIANCE_DIMENSION_LABELS[count.dimension] ??
                          count.dimension}
                      </th>
                      <td className="r num">{count.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          ))}
        </PanelGrid>
      )}
      {workspace.held.complaints || workspace.held.legalHolds ? (
        <div className="st-links">
          {workspace.held.complaints ? (
            <a className="btn btn-line btn-sm" href="/staff/complaints">
              Open reported problems
            </a>
          ) : null}
          {workspace.held.legalHolds ? (
            <a className="btn btn-line btn-sm" href="/staff/legal-holds">
              Open Legal Holds
            </a>
          ) : null}
        </div>
      ) : null}
      {workspace.sections.records === "unavailable" ? (
        <>
          <h2 className="st-h2">Attorney records</h2>
          <p className="st-emd">
            The attorney records could not be shown right now.
          </p>
        </>
      ) : null}
      {workspace.records === null || workspace.pager === null ? null : (
        <>
          <h2 className="st-h2">Attorney records</h2>
          <TabLinks
            label="Attorney records by section"
            links={COMPLIANCE_SECTIONS.map((entry) => ({
              href: `/staff/compliance?section=${entry}`,
              label: COMPLIANCE_SECTION_LABELS[entry],
            }))}
            current={recordsBase}
          />
          <p className="st-emd">
            {COMPLIANCE_SECTION_NOTES[workspace.section]}
          </p>
          <ListBox
            label={COMPLIANCE_SECTION_LABELS[workspace.section]}
            columns={RECORD_COLUMNS}
          >
            {workspace.records.length === 0 ? (
              <Empty
                title={
                  workspace.pager.page === 1
                    ? "There is nothing in this section."
                    : "There is nothing on this page."
                }
              />
            ) : (
              workspace.records.map((record) => {
                const stage = PROFILE_STAGE_LABELS[record.profileState];
                return (
                  <ListRow
                    key={`${record.recordType}-${record.recordId}`}
                    columns={6}
                  >
                    <Cell label="Attorney" strong>
                      {record.displayName ?? "No name recorded"}
                    </Cell>
                    <Cell label="Jurisdiction">
                      {record.jurisdictionId === null
                        ? "—"
                        : jurisdictionLabel(
                            workspace.names,
                            record.jurisdictionId,
                          )}
                    </Cell>
                    <Cell label="Recorded">
                      {record.recordedAt === null
                        ? "No evidence recorded"
                        : utcText(record.recordedAt)}
                    </Cell>
                    <Cell label="Date">
                      {[record.lapsesOn, record.statusCode]
                        .filter((part) => part !== null)
                        .join(", ") || "—"}
                    </Cell>
                    <PillCell label="Stage" tone={stage.tone}>
                      {stage.label}
                    </PillCell>
                    <ActionCell>
                      {workspace.attorneyPages ? (
                        <ButtonLink
                          variant="tertiary"
                          href={`/staff/attorneys/${record.attorneyId}`}
                        >
                          Open
                        </ButtonLink>
                      ) : (
                        "Not in your scope"
                      )}
                    </ActionCell>
                  </ListRow>
                );
              })
            )}
          </ListBox>
          {workspace.pager.page === 1 && !workspace.pager.hasNext ? null : (
            <PagerRow
              note={`Page ${workspace.pager.page} of this section.`}
              previous={
                workspace.pager.page > 1
                  ? `${recordsBase}&records=${workspace.pager.page - 1}`
                  : null
              }
              next={
                workspace.pager.hasNext
                  ? `${recordsBase}&records=${workspace.pager.page + 1}`
                  : null
              }
            />
          )}
        </>
      )}
      {view === null ? null : (
        <>
          <h2 className="st-h2">Compliance review items</h2>
          <p className="st-emd">
            An eligibility or jurisdiction change that affects an open request
            or consultation, a possible return of a removed attorney, or a
            client account suspended with open matters is recorded here for a
            person to review. Nothing is decided automatically.
          </p>
          {view.status !== "ready" ? (
            <p className="st-emd">
              The review items could not be shown right now.
            </p>
          ) : (
            <ReviewItemList
              view={view}
              base={`/staff/compliance?status=${view.exceptionStatus}`}
              pageParameter="page"
              assignAction={assignComplianceItemAction}
              resolveAction={resolveComplianceItemAction}
            />
          )}
        </>
      )}
      {workspace.sections.policyChanges === "unavailable" ? (
        <>
          <h2 className="st-h2">Recent policy status changes</h2>
          <p className="st-emd">
            The policy status changes could not be shown right now.
          </p>
        </>
      ) : null}
      {workspace.policyChanges === null ? null : (
        <>
          <h2 className="st-h2">Recent policy status changes</h2>
          <ListBox
            label="Policy version status changes, newest first"
            columns={CHANGE_COLUMNS}
          >
            {workspace.policyChanges.length === 0 ? (
              <Empty title="No policy status change is recorded in your scope." />
            ) : (
              workspace.policyChanges.map((change) => (
                <ListRow
                  key={change.id}
                  href={`/staff/policies/${change.versionId}`}
                  columns={5}
                >
                  <Cell label="When" strong>
                    {utcText(change.occurredAt)}
                  </Cell>
                  <Cell label="Policy type">{change.typeCode}</Cell>
                  <Cell label="Scope">
                    {change.jurisdictionId === null
                      ? "Every jurisdiction"
                      : jurisdictionLabel(
                          workspace.names,
                          change.jurisdictionId,
                        )}
                  </Cell>
                  <Cell label="From">
                    {change.fromStatus === null
                      ? "—"
                      : (POLICY_STATUS_TEXT[change.fromStatus] ??
                        change.fromStatus)}
                  </Cell>
                  <Cell label="To">
                    {change.toStatus === null
                      ? "—"
                      : (POLICY_STATUS_TEXT[change.toStatus] ??
                        change.toStatus)}
                  </Cell>
                </ListRow>
              ))
            )}
          </ListBox>
        </>
      )}
    </StaffFrame>
  );
}
