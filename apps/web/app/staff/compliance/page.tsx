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
import {
  ButtonLink,
  Cluster,
  Heading,
  Status,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
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
import { requireSteppedUp } from "../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../frame.tsx";
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
  return (
    <StaffFrame eyebrow="Compliance" title="Compliance">
      <BackLink href="/staff">Staff tools</BackLink>
      <Text tone="muted">{COMPLIANCE_INTRO}</Text>
      {COUNT_GROUPS.filter(
        (group) => workspace.counts[group] !== undefined,
      ).map((group) => (
        <Table
          key={group}
          id={`compliance-counts-${group}`}
          caption={COMPLIANCE_COUNT_TITLES[group]}
        >
          <tbody>
            {workspace.counts[group].map((count) => (
              <tr key={count.dimension}>
                <th scope="row">
                  {COMPLIANCE_DIMENSION_LABELS[count.dimension] ??
                    count.dimension}
                </th>
                <td>{count.value}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      ))}
      {workspace.held.complaints ? (
        <Cluster>
          <ButtonLink variant="secondary" href="/staff/complaints">
            Open reported problems
          </ButtonLink>
        </Cluster>
      ) : null}
      {workspace.held.legalHolds ? (
        <Cluster>
          <ButtonLink variant="secondary" href="/staff/legal-holds">
            Open Legal Holds
          </ButtonLink>
        </Cluster>
      ) : null}
      {workspace.sections.records === "unavailable" ? (
        <>
          <Heading as="h2" size="md">
            Attorney records
          </Heading>
          <Text tone="muted">
            The attorney records could not be shown right now.
          </Text>
        </>
      ) : null}
      {workspace.records === null || workspace.pager === null ? null : (
        <>
          <Heading as="h2" size="md">
            Attorney records
          </Heading>
          <Cluster>
            {COMPLIANCE_SECTIONS.map((entry) => (
              <ButtonLink
                key={entry}
                variant={entry === workspace.section ? "primary" : "secondary"}
                href={`/staff/compliance?section=${entry}`}
                aria-current={entry === workspace.section ? "page" : undefined}
              >
                {COMPLIANCE_SECTION_LABELS[entry]}
              </ButtonLink>
            ))}
          </Cluster>
          <Text size="small" tone="muted">
            {COMPLIANCE_SECTION_NOTES[workspace.section]}
          </Text>
          {workspace.records.length === 0 ? (
            <Text>
              {workspace.pager.page === 1
                ? "There is nothing in this section."
                : "There is nothing on this page."}
            </Text>
          ) : (
            <Table
              id="compliance-records"
              caption={COMPLIANCE_SECTION_LABELS[workspace.section]}
            >
              <thead>
                <tr>
                  <th scope="col">Attorney</th>
                  <th scope="col">Stage</th>
                  <th scope="col">Jurisdiction</th>
                  <th scope="col">Recorded (UTC)</th>
                  <th scope="col">Date</th>
                  <th scope="col">Open</th>
                </tr>
              </thead>
              <tbody>
                {workspace.records.map((record) => {
                  const stage = PROFILE_STAGE_LABELS[record.profileState];
                  return (
                    <tr key={`${record.recordType}-${record.recordId}`}>
                      <td>{record.displayName ?? "No name recorded"}</td>
                      <td>
                        <Status tone={stage.tone}>{stage.label}</Status>
                      </td>
                      <td>
                        {record.jurisdictionId === null
                          ? "—"
                          : jurisdictionLabel(
                              workspace.names,
                              record.jurisdictionId,
                            )}
                      </td>
                      <td>
                        {record.recordedAt === null
                          ? "No evidence recorded"
                          : utcText(record.recordedAt)}
                      </td>
                      <td>
                        {[record.lapsesOn, record.statusCode]
                          .filter((part) => part !== null)
                          .join(", ") || "—"}
                      </td>
                      <td>
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
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          <Cluster>
            {workspace.pager.page > 1 ? (
              <ButtonLink
                variant="secondary"
                href={`${recordsBase}&records=${workspace.pager.page - 1}`}
              >
                Previous page
              </ButtonLink>
            ) : null}
            {workspace.pager.hasNext ? (
              <ButtonLink
                variant="secondary"
                href={`${recordsBase}&records=${workspace.pager.page + 1}`}
              >
                Next page
              </ButtonLink>
            ) : null}
          </Cluster>
        </>
      )}
      {view === null ? null : (
        <>
          <Heading as="h2" size="md">
            Compliance review items
          </Heading>
          <Text tone="muted">
            An eligibility or jurisdiction change that affects an open request
            or consultation, a possible return of a removed attorney, or a
            client account suspended with open matters is recorded here for a
            person to review. Nothing is decided automatically.
          </Text>
          {view.status !== "ready" ? (
            <Text tone="muted">
              The review items could not be shown right now.
            </Text>
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
          <Heading as="h2" size="md">
            Recent policy status changes
          </Heading>
          <Text tone="muted">
            The policy status changes could not be shown right now.
          </Text>
        </>
      ) : null}
      {workspace.policyChanges === null ? null : (
        <>
          <Heading as="h2" size="md">
            Recent policy status changes
          </Heading>
          {workspace.policyChanges.length === 0 ? (
            <Text>No policy status change is recorded in your scope.</Text>
          ) : (
            <Table
              id="compliance-policy-changes"
              caption="Policy version status changes, newest first"
            >
              <thead>
                <tr>
                  <th scope="col">When (UTC)</th>
                  <th scope="col">Policy type</th>
                  <th scope="col">Scope</th>
                  <th scope="col">From</th>
                  <th scope="col">To</th>
                  <th scope="col">Open</th>
                </tr>
              </thead>
              <tbody>
                {workspace.policyChanges.map((change) => (
                  <tr key={change.id}>
                    <td>{utcText(change.occurredAt)}</td>
                    <td>{change.typeCode}</td>
                    <td>
                      {change.jurisdictionId === null
                        ? "Every jurisdiction"
                        : jurisdictionLabel(
                            workspace.names,
                            change.jurisdictionId,
                          )}
                    </td>
                    <td>
                      {change.fromStatus === null
                        ? "—"
                        : (POLICY_STATUS_TEXT[change.fromStatus] ??
                          change.fromStatus)}
                    </td>
                    <td>
                      {change.toStatus === null
                        ? "—"
                        : (POLICY_STATUS_TEXT[change.toStatus] ??
                          change.toStatus)}
                    </td>
                    <td>
                      <ButtonLink
                        variant="tertiary"
                        href={`/staff/policies/${change.versionId}`}
                      >
                        Open
                      </ButtonLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </>
      )}
    </StaffFrame>
  );
}
