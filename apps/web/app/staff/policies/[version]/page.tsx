// One policy version and its authority references (MVP-001 S1).
//
// Rendered on the server for every request. The route segment only names
// which version to look at: a fresh staff identity and the database's own
// capability predicate for the version's scope decide access, and a version
// the caller's session cannot read looks exactly like one that does not
// exist. Only the changes the version's current state allows are offered,
// and only on a recorded environment that matches this deployment; the
// database decides each change again.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, the Approvals record):
// the design's record panel with the status pill, the version and its
// parameters, the authority references, and the lifecycle, revision, end
// and successor forms the state admits, all unchanged.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolvePolicyVersion } from "../../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import {
  Alert,
  Disclosure,
  Status,
  TextAreaField,
} from "../../../../src/presentation/design-system.tsx";
import {
  ENVIRONMENT_LABELS,
  periodLabel,
  POLICY_STATUS_LABELS,
  recordedStateLabel,
  utcDateTime,
} from "../../../../src/presentation/staff-configuration-labels.ts";
import {
  Block,
  KeyValues,
  RecordPanel,
} from "../../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../../account/gate.ts";
import { BoundNotice, refusalPage } from "../../frame.tsx";
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
    <RecordPanel
      titleId="staff-configuration-title"
      title={`${v.type}: ${v.label}`}
      sub="Policy version · times in UTC"
      pill={
        v.developmentOnly
          ? { tone: "warning", label: "Development configuration" }
          : { tone: status.tone, label: status.label }
      }
      back={{ href: "/staff/policies", label: "Back to policy versions" }}
    >
      {v.developmentOnly ? (
        <Block>
          <Alert tone="warning" title="Development configuration" role="status">
            This version is development configuration: it is never approved, it
            is selected only in development or staging databases, and it is
            fixed except for a single end.
          </Alert>
        </Block>
      ) : null}
      <Block title="Policy version">
        <KeyValues
          items={[
            ["Policy type", v.type],
            ["Scope", v.jurisdiction],
            ["Version label", v.label],
            [
              "Status",
              v.developmentOnly ? "Development configuration" : status.label,
            ],
            ["Effective", periodLabel(v.effectiveFrom, v.effectiveUntil)],
            [
              "Approved",
              v.approvedAt === null
                ? "Not approved"
                : `${utcDateTime(v.approvedAt)} by ${v.approvedBy ?? "staff"}`,
            ],
            [
              "Supersedes",
              v.supersedesId === null ? "None" : "An earlier version",
            ],
            ["Last changed", utcDateTime(v.updatedAt)],
          ]}
        />
        <TextAreaField
          id="policy-parameters"
          label="Parameters"
          rows={10}
          readOnly
          defaultValue={v.parametersText}
        />
      </Block>
      <Block title="Authority references">
        <BoundNotice
          complete={view.referencesComplete}
          noun="authority references"
        />
        {view.references.length === 0 ? (
          <p className="st-emd">No authority reference is recorded.</p>
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
                <KeyValues
                  items={[
                    ["Citation", reference.citation],
                    ["Source address", reference.sourceUri ?? "Not recorded"],
                    ["Retrieved", utcDateTime(reference.retrievedAt)],
                    [
                      "Verification",
                      <>
                        <Status tone={state.tone}>{state.label}</Status>
                        {reference.verifiedBy === null
                          ? null
                          : ` (by ${reference.verifiedBy})`}
                      </>,
                    ],
                  ]}
                />
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
      </Block>
      {changes && view.transitions.length > 0 ? (
        <Block title="Lifecycle">
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
        </Block>
      ) : null}
      {(changes && view.canEnd) || (changes && view.canSucceed) ? (
        <Block title="End or succeed">
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
        </Block>
      ) : null}
    </RecordPanel>
  );
}
