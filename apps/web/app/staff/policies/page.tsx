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

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolvePolicyWorkspace } from "../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import {
  Alert,
  ButtonLink,
  Disclosure,
  Heading,
  Status,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import {
  ENVIRONMENT_LABELS,
  periodLabel,
  POLICY_STATUS_LABELS,
} from "../../../src/presentation/staff-configuration-labels.ts";
import { requireSteppedUp } from "../../account/gate.ts";
import {
  BackLink,
  BoundNotice,
  PagerLinks,
  refusalPage,
  StaffFrame,
} from "../frame.tsx";
import { CreatePolicyForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Policy configuration",
  robots: { index: false, follow: false },
};

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
    <StaffFrame eyebrow="Staff configuration" title="Policy configuration">
      <BackLink href="/staff">Staff tools</BackLink>
      <Text tone="muted">
        {`Database environment: ${ENVIRONMENT_LABELS[view.environment]}.`}
      </Text>
      {view.canChange ? null : (
        <Alert tone="warning" title="Policy changes are refused" role="status">
          The database environment is not recorded, or it does not match this
          deployment&apos;s settings. Policy versions can be read, but nothing
          can be created or changed until that is resolved.
        </Alert>
      )}
      {view.versions.length === 0 && view.pager.page === 1 ? (
        <Text>There are no policy versions you can read yet.</Text>
      ) : null}
      {view.versions.length === 0 ? null : (
        <Table id="policy-versions" caption="Policy versions, newest first">
          <thead>
            <tr>
              <th scope="col">Policy type</th>
              <th scope="col">Scope</th>
              <th scope="col">Version</th>
              <th scope="col">Status</th>
              <th scope="col">Effective</th>
              <th scope="col">Open</th>
            </tr>
          </thead>
          <tbody>
            {view.versions.map((version) => (
              <tr key={version.id}>
                <td>{version.type}</td>
                <td>{version.jurisdiction}</td>
                <td>{version.label}</td>
                <td>
                  {version.developmentOnly ? (
                    <Status tone="warning" emphasis="strong">
                      Development configuration
                    </Status>
                  ) : (
                    <Status tone={POLICY_STATUS_LABELS[version.status].tone}>
                      {POLICY_STATUS_LABELS[version.status].label}
                    </Status>
                  )}
                </td>
                <td>
                  {periodLabel(version.effectiveFrom, version.effectiveUntil)}
                </td>
                <td>
                  <ButtonLink
                    variant="tertiary"
                    href={`/staff/policies/${version.id}`}
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
        base="/staff/policies"
        noun="policy versions"
        shown={view.versions.length}
      />
      {view.canChange ? (
        <>
          <Heading as="h2" size="md">
            New policy version
          </Heading>
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
            <Text tone="muted">
              A new version needs a policy type and a scope you hold the policy
              capability for.
            </Text>
          ) : (
            <Disclosure summary="Create a draft policy version">
              <CreatePolicyForm
                mode="new"
                policyTypes={view.policyTypes}
                scopes={view.scopes}
                developmentAllowed={view.developmentAllowed}
              />
            </Disclosure>
          )}
        </>
      ) : null}
    </StaffFrame>
  );
}
