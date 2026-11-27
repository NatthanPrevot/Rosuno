// Policy configuration (MVP-001 S1).
//
// Rendered on the server for every request. A fresh staff identity and the
// database's own capability predicate decide access; the versions listed are
// only those the caller's own session may read under the row policies, one
// page at a time, newest first. The one query value read, page, only asks
// which page to show; the server checks it and shows the first page for
// anything else. Policy changes are offered only on a recorded environment
// that matches this deployment, and development configuration only where
// the database records a development or staging environment.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Owner › Approvals): the
// design's list of policy versions, each row opening its record, then the
// pager and the draft form in a panel. No owner role exists: the Approvals
// destination is this page, for holders of the policy capability.
//
// DEV-001: the development test configuration panel is shown only when the
// workspace offers it: a global policy capability holder, past this page's
// step-up check, on a recorded development or staging environment that
// matches this deployment, where exactly one development regulatory mode
// exists. Its server action checks all of that again.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolvePolicyWorkspace } from "../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import { Alert, Disclosure } from "../../../src/presentation/design-system.tsx";
import {
  ENVIRONMENT_LABELS,
  periodLabel,
  POLICY_STATUS_LABELS,
} from "../../../src/presentation/staff-configuration-labels.ts";
import {
  Cell,
  Empty,
  ListBox,
  ListRow,
  Panel,
  PillCell,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { BoundNotice, PagerLinks, refusalPage, StaffFrame } from "../frame.tsx";
import {
  CreatePolicyForm,
  DevelopmentTestConfigurationForm,
} from "./forms.tsx";

export const metadata: Metadata = {
  title: "Policy configuration",
  robots: { index: false, follow: false },
};

const COLUMNS = ["Policy type", "Scope", "Effective", "Status"] as const;

export default async function PolicyConfigurationPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string | string[] }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { page } = await searchParams;
  const view = await resolvePolicyWorkspace(STAFF_CONFIGURATION_SOURCES, page);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/policies", "Policy configuration");
  }
  return (
    <StaffFrame
      title="Approvals"
      subtitle="Policy versions: drafts, review, approval and their authority references."
      lead={
        <p>{`Database environment: ${ENVIRONMENT_LABELS[view.environment]}.`}</p>
      }
    >
      {view.canChange ? null : (
        <Alert tone="warning" title="Policy changes are refused" role="status">
          The database environment is not recorded, or it does not match this
          deployment&apos;s settings. Policy versions can be read, but nothing
          can be created or changed until that is resolved.
        </Alert>
      )}
      <ListBox label="Policy versions, newest first" columns={COLUMNS} sub>
        {view.versions.length === 0 && view.pager.page === 1 ? (
          <Empty title="There are no policy versions you can read yet." />
        ) : null}
        {view.versions.map((version) => (
          <ListRow
            key={version.id}
            href={`/staff/policies/${version.id}`}
            columns={4}
            sub
          >
            <Cell label="Policy type" strong>
              {version.type}
            </Cell>
            <Cell label="">{version.label}</Cell>
            <Cell label="Scope">{version.jurisdiction}</Cell>
            <Cell label="Effective">
              {periodLabel(version.effectiveFrom, version.effectiveUntil)}
            </Cell>
            {version.developmentOnly ? (
              <PillCell label="Status" tone="warning">
                Development configuration
              </PillCell>
            ) : (
              <PillCell
                label="Status"
                tone={POLICY_STATUS_LABELS[version.status].tone}
              >
                {POLICY_STATUS_LABELS[version.status].label}
              </PillCell>
            )}
          </ListRow>
        ))}
      </ListBox>
      <PagerLinks
        pager={view.pager}
        base="/staff/policies"
        noun="policy versions"
        shown={view.versions.length}
      />
      {view.canChange ? (
        <Panel id="policy-new-title" title="New policy version">
          <BoundNotice
            complete={view.policyTypesComplete}
            noun="policy types"
          />
          <BoundNotice complete={view.scopesComplete} noun="jurisdictions" />
          {view.developmentAllowed ? (
            <Alert tone="warning" title="Development or staging database">
              {`This database is recorded as a ${view.environment} environment, so development configuration can be created here. It is never approved and is never selected in production.`}
            </Alert>
          ) : null}
          {view.policyTypes.length === 0 || view.scopes.length === 0 ? (
            <p className="st-emd">
              A new version needs a policy type and a scope you hold the policy
              capability for.
            </p>
          ) : (
            <Disclosure summary="Create a draft policy version">
              <CreatePolicyForm
                mode="new"
                policyTypes={view.policyTypes}
                scopes={view.scopes}
                developmentAllowed={view.developmentAllowed}
                regulatoryModes={view.regulatoryModes}
              />
            </Disclosure>
          )}
        </Panel>
      ) : null}
      {view.canChange &&
      view.developmentAllowed &&
      view.developmentTest !== null ? (
        <Panel
          id="policy-development-test-title"
          title="Development test configuration — test values, not policy"
        >
          <Alert tone="warning" title="Development-only test values">
            {`These versions only make ${view.environment} testing possible. They decide no product, legal, regulatory or production policy, are created as development configuration in your name, and are refused in production.`}
          </Alert>
          <DevelopmentTestConfigurationForm
            jurisdiction={view.developmentTest.jurisdictionLabel}
            regulatoryMode={view.developmentTest.regulatoryModeLabel}
          />
        </Panel>
      ) : null}
    </StaffFrame>
  );
}
