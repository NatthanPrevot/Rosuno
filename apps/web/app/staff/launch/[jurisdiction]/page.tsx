// One jurisdiction's launch gates and launch authorization (MVP-001 S1).
//
// Rendered on the server for every request. The route segment only names
// which jurisdiction to look at: a fresh staff identity and the database's
// own capability predicate for exactly that jurisdiction decide access and
// what is offered. Gate definitions and evaluations need the jurisdiction-
// configuration capability; a launch authorization, a human decision, needs
// the launch-authorization capability. Nothing here makes a jurisdiction
// live: that is a lifecycle change the database decides.
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, the Marketplace launch
// record): the design's record panel with the required gates passed as its
// key fact, the launch readiness, the gates and their evaluations, and the
// launch authorizations, each with its unchanged forms.

import type { Metadata } from "next";
import { connection } from "next/server";

import { resolveLaunch } from "../../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import {
  Disclosure,
  Status,
  Table,
  Text,
} from "../../../../src/presentation/design-system.tsx";
import {
  LIFECYCLE_LABELS,
  recordedStateLabel,
  utcDateTime,
} from "../../../../src/presentation/staff-configuration-labels.ts";
import {
  Block,
  KeyFact,
  KeyValues,
  RecordPanel,
} from "../../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../../account/gate.ts";
import { BoundNotice, refusalPage } from "../../frame.tsx";
import {
  DefineGateForm,
  EvaluationForm,
  GrantLaunchForm,
  RevokeLaunchForm,
} from "../forms.tsx";

export const metadata: Metadata = {
  title: "Launch gates and authorization",
  robots: { index: false, follow: false },
};

export default async function JurisdictionLaunchPage({
  params,
}: {
  readonly params: Promise<{ readonly jurisdiction: string }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { jurisdiction } = await params;
  const view = await resolveLaunch(STAFF_CONFIGURATION_SOURCES, jurisdiction);
  if (view.status !== "ready") {
    return refusalPage(
      view,
      "/staff/launch/[jurisdiction]",
      "Launch gates and authorization",
    );
  }
  const j = view.jurisdiction;
  return (
    <RecordPanel
      titleId="staff-configuration-title"
      title={`${j.name} (${j.code})`}
      sub="Launch gates and authorization · times in UTC"
      pill={{
        tone: LIFECYCLE_LABELS[j.state].tone,
        label: LIFECYCLE_LABELS[j.state].label,
      }}
      back={{ href: "/staff/launch", label: "Back to jurisdictions" }}
    >
      <KeyFact
        label="Required gates passed (latest evaluation)"
        value={`${view.requiredPassed} of ${view.requiredGates}`}
      />
      <Block title="Launch readiness">
        <KeyValues
          items={[
            ["Lifecycle", LIFECYCLE_LABELS[j.state].label],
            [
              "Active launch authorization",
              view.hasActiveAuthorization ? "Yes" : "No",
            ],
          ]}
        />
      </Block>
      <Block title="Launch gates">
        <BoundNotice complete={view.gatesComplete} noun="launch gates" />
        {view.gates.length === 0 ? (
          <p className="st-emd">No launch gate is defined.</p>
        ) : (
          view.gates.map((gate) => {
            const latest = gate.evaluations[0];
            const state =
              latest === undefined ? null : recordedStateLabel(latest.status);
            return (
              <Disclosure
                key={gate.id}
                summary={`${gate.code} (${gate.required ? "required" : "not required"}): ${state === null ? "not evaluated" : state.label}`}
              >
                {gate.description === null ? null : (
                  <Text>{gate.description}</Text>
                )}
                {gate.evaluations.length === 0 ? (
                  <Text tone="muted">No evaluation is recorded.</Text>
                ) : (
                  <Table
                    id={`evaluations-${gate.id}`}
                    caption="Recent evaluations, newest first"
                  >
                    <thead>
                      <tr>
                        <th scope="col">Evaluated</th>
                        <th scope="col">Result</th>
                        <th scope="col">By</th>
                        <th scope="col">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gate.evaluations.map((evaluation) => {
                        const result = recordedStateLabel(evaluation.status);
                        return (
                          <tr key={evaluation.id}>
                            <td>{utcDateTime(evaluation.evaluatedAt)}</td>
                            <td>
                              <Status tone={result.tone}>{result.label}</Status>
                            </td>
                            <td>{evaluation.by ?? "Not recorded"}</td>
                            <td>{evaluation.reason ?? "Not recorded"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </Table>
                )}
                {gate.evaluationsComplete ? null : (
                  <Text tone="muted">
                    Older evaluations are kept but not shown here.
                  </Text>
                )}
                {view.canManageGates ? <EvaluationForm gate={gate.id} /> : null}
              </Disclosure>
            );
          })
        )}
        {view.canManageGates ? (
          <Disclosure summary="Define a launch gate">
            <DefineGateForm jurisdiction={j.id} />
          </Disclosure>
        ) : null}
      </Block>
      <Block title="Launch authorizations">
        <BoundNotice
          complete={view.authorizationsComplete}
          noun="launch authorizations"
        />
        {view.authorizations.length === 0 ? (
          <p className="st-emd">No launch authorization is recorded.</p>
        ) : (
          view.authorizations.map((authorization) => (
            <Disclosure
              key={authorization.id}
              summary={`${utcDateTime(authorization.authorizedAt)} by ${authorization.by}: ${authorization.revokedAt === null ? "active" : `revoked ${utcDateTime(authorization.revokedAt)}`}`}
            >
              <Text>{authorization.reason}</Text>
              {view.canAuthorize && authorization.revokedAt === null ? (
                <RevokeLaunchForm authorization={authorization.id} />
              ) : null}
            </Disclosure>
          ))
        )}
        {view.canAuthorize && !view.hasActiveAuthorization ? (
          <Disclosure summary="Grant launch authorization">
            <GrantLaunchForm jurisdiction={j.id} />
          </Disclosure>
        ) : null}
        {view.canAuthorize ? null : (
          <p className="st-emd">
            Granting or revoking launch authorization needs the
            launch-authorization capability for this jurisdiction.
          </p>
        )}
      </Block>
    </RecordPanel>
  );
}
