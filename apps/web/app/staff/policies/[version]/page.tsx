// One policy version and its authority references (MVP-001 S1).
//
// Rendered on the server for every request. The route segment only names
// which version to look at: a fresh staff identity and the database's own
// capability predicate for the version's scope decide access, and a version
// the caller's session cannot read looks exactly like one that does not
// exist. Only the changes the version's current state allows are offered,
// and only on a recorded environment that matches this deployment; the
// database decides each change again.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolvePolicyVersion } from "../../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import {
  Alert,
  Disclosure,
  Heading,
  Status,
  Table,
  Text,
  TextAreaField,
} from "../../../../src/presentation/design-system.tsx";
import {
  ENVIRONMENT_LABELS,
  periodLabel,
  POLICY_STATUS_LABELS,
  recordedStateLabel,
  utcDateTime,
} from "../../../../src/presentation/staff-configuration-labels.ts";
import { requireSteppedUp } from "../../../account/gate.ts";
import {
  BackLink,
  BoundNotice,
  refusalPage,
  StaffFrame,
} from "../../frame.tsx";
import {
  AuthorityReferenceForm,
  CreatePolicyForm,
  DecideReferenceForm,
  EndPolicyForm,
  RevisePolicyForm,
  TransitionPolicyForm,
} from "../forms.tsx";

export const metadata: Metadata = {
  title: "Policy version",
  robots: { index: false, follow: false },
};

export default async function PolicyVersionPage({
  params,
}: {
  readonly params: Promise<{ readonly version: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { version } = await params;
  const view = await resolvePolicyVersion(STAFF_CONFIGURATION_SOURCES, version);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/policies/[version]", "Policy version");
  }
  const v = view.version;
  const status = POLICY_STATUS_LABELS[v.status];
  const changes = view.canChange;
  return (
    <StaffFrame eyebrow="Staff configuration" title={`${v.type}: ${v.label}`}>
      <BackLink href="/staff/policies">Back to policy versions</BackLink>
      {v.developmentOnly ? (
        <Alert tone="warning" title="Development configuration" role="status">
          This version is development configuration: it is never approved, it is
          selected only in development or staging databases, and it is fixed
          except for a single end.
        </Alert>
      ) : null}
      <Table id="policy-version" caption="Policy version">
        <tbody>
          <tr>
            <th scope="row">Policy type</th>
            <td>{v.type}</td>
          </tr>
          <tr>
            <th scope="row">Scope</th>
            <td>{v.jurisdiction}</td>
          </tr>
          <tr>
            <th scope="row">Version label</th>
            <td>{v.label}</td>
          </tr>
          <tr>
            <th scope="row">Status</th>
            <td>
              {v.developmentOnly ? (
                <Status tone="warning" emphasis="strong">
                  Development configuration
                </Status>
              ) : (
                <Status tone={status.tone}>{status.label}</Status>
              )}
            </td>
          </tr>
          <tr>
            <th scope="row">Effective</th>
            <td>{periodLabel(v.effectiveFrom, v.effectiveUntil)}</td>
          </tr>
          <tr>
            <th scope="row">Approved</th>
            <td>
              {v.approvedAt === null
                ? "Not approved"
                : `${utcDateTime(v.approvedAt)} by ${v.approvedBy ?? "staff"}`}
            </td>
          </tr>
          <tr>
            <th scope="row">Supersedes</th>
            <td>{v.supersedesId === null ? "None" : "An earlier version"}</td>
          </tr>
          <tr>
            <th scope="row">Last changed</th>
            <td>{utcDateTime(v.updatedAt)}</td>
          </tr>
        </tbody>
      </Table>
      <TextAreaField
        id="policy-parameters"
        label="Parameters"
        rows={10}
        readOnly
        defaultValue={v.parametersText}
      />
      <Heading as="h2" size="md">
        Authority references
      </Heading>
      <BoundNotice
        complete={view.referencesComplete}
        noun="authority references"
      />
      {view.references.length === 0 ? (
        <Text tone="muted">No authority reference is recorded.</Text>
      ) : (
        view.references.map((reference) => {
          const state = recordedStateLabel(reference.status);
          const decisions = (["verified", "rejected"] as const).filter(
            (decision) => decision !== reference.status,
          );
          return (
            <Disclosure
              key={reference.id}
              summary={`${reference.authorityType}: ${reference.sourceTitle}`}
            >
              <Table
                id={`reference-${reference.id}`}
                caption="Authority reference"
              >
                <tbody>
                  <tr>
                    <th scope="row">Citation</th>
                    <td>{reference.citation}</td>
                  </tr>
                  <tr>
                    <th scope="row">Source address</th>
                    <td>{reference.sourceUri ?? "Not recorded"}</td>
                  </tr>
                  <tr>
                    <th scope="row">Retrieved</th>
                    <td>{utcDateTime(reference.retrievedAt)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Verification</th>
                    <td>
                      <Status tone={state.tone}>{state.label}</Status>
                      {reference.verifiedBy === null
                        ? null
                        : ` (by ${reference.verifiedBy})`}
                    </td>
                  </tr>
                </tbody>
              </Table>
              {changes && view.draftFamily ? (
                <DecideReferenceForm
                  reference={reference.id}
                  decisions={decisions}
                />
              ) : null}
            </Disclosure>
          );
        })
      )}
      {changes ? null : (
        <Alert tone="warning" title="Changes are refused here" role="status">
          {`${ENVIRONMENT_LABELS[view.environment]}: policy changes are refused until the database environment is recorded and matches this deployment.`}
        </Alert>
      )}
      {changes && view.draftFamily ? (
        <>
          <Disclosure summary="Add an authority reference">
            <AuthorityReferenceForm version={v.id} />
          </Disclosure>
          <Disclosure summary="Revise this draft">
            <RevisePolicyForm
              version={v.id}
              expectedUpdatedAt={v.updatedAt}
              label={v.label}
              parametersText={v.parametersText}
              effectiveFrom={v.effectiveFrom}
              effectiveUntil={v.effectiveUntil}
            />
          </Disclosure>
        </>
      ) : null}
      {changes && view.transitions.length > 0 ? (
        <>
          <Heading as="h2" size="md">
            Lifecycle
          </Heading>
          {view.transitions.includes("approved") &&
          !view.hasVerifiedReference ? (
            <Alert tone="information">
              Approval needs at least one authority reference verified by staff,
              and an effective start.
            </Alert>
          ) : null}
          {view.transitions.map((target) => (
            <TransitionPolicyForm
              key={target}
              version={v.id}
              expectedUpdatedAt={v.updatedAt}
              target={target}
            />
          ))}
        </>
      ) : null}
      {changes && view.canEnd ? (
        <Disclosure summary="End this version">
          <EndPolicyForm version={v.id} />
        </Disclosure>
      ) : null}
      {changes && view.canSucceed ? (
        <Disclosure summary="Draft a successor version">
          <CreatePolicyForm
            mode="successor"
            supersedes={v.id}
            parametersText={v.parametersText}
          />
        </Disclosure>
      ) : null}
    </StaffFrame>
  );
}
