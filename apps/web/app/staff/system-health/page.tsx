// System health (MVP-001 S11 pass 2; MBS section 18.4 "system health"; TA
// section 18; PS-A2 section 6).
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs the global view_operations grant (the database
// decides again). It shows the database's recorded environment class and
// status, whether this deployment's settings match that record, whether the
// scheduled database sweeps are registered, and whether each provider's
// settings have their declared shape (configured or not configured, never a
// value). Hosted checks are out of scope here. It reads no query, header or
// cookie.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  PROVIDER_AREAS,
  resolveSystemHealth,
  type Sweep,
} from "../../../src/application/operations-workspace.ts";
import { OPERATIONS_WORKSPACE_SOURCES } from "../../../src/infrastructure/staff/operations-adapter.ts";
import {
  Alert,
  ButtonLink,
  Cluster,
  Status,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import {
  HOSTED_CHECKS_NOTE,
  PROVIDER_AREA_LABELS,
  PROVIDER_STATUS_LABELS,
  ENVIRONMENT_CLASS_LABELS,
  ENVIRONMENT_STATUS_LABELS,
  SWEEP_LABELS,
  SYSTEM_HEALTH_NOTE,
} from "../../../src/presentation/operations-labels.ts";
import { ENVIRONMENT_LABELS } from "../../../src/presentation/staff-configuration-labels.ts";
import { requireSteppedUp } from "../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../frame.tsx";

export const metadata: Metadata = {
  title: "System health",
  robots: { index: false, follow: false },
};

export default async function SystemHealthPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const view = await resolveSystemHealth(OPERATIONS_WORKSPACE_SOURCES);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/system-health", "System health");
  }
  const { summary, binding, providers } = view;
  const status = ENVIRONMENT_STATUS_LABELS[summary.environmentStatus];
  const scheduler = summary.counts.scheduler;
  const installed = scheduler[0]?.value === 1;
  return (
    <StaffFrame eyebrow="Operations" title="System health">
      <BackLink href="/staff">Staff tools</BackLink>
      <Table id="system-health-environment" caption="Environment">
        <tbody>
          <tr>
            <th scope="row">Recorded database environment</th>
            <td>{ENVIRONMENT_CLASS_LABELS[summary.environmentClass]}</td>
          </tr>
          <tr>
            <th scope="row">Environment record</th>
            <td>
              <Status tone={status.tone}>{status.label}</Status>
            </td>
          </tr>
          <tr>
            <th scope="row">This deployment&apos;s settings</th>
            <td>
              <Status
                tone={
                  binding === "unrecorded" || binding === "mismatch"
                    ? "error"
                    : "success"
                }
              >
                {ENVIRONMENT_LABELS[binding]}
              </Status>
            </td>
          </tr>
        </tbody>
      </Table>
      <Table id="system-health-providers" caption="Provider configuration">
        <thead>
          <tr>
            <th scope="col">Area</th>
            <th scope="col">Settings</th>
          </tr>
        </thead>
        <tbody>
          {PROVIDER_AREAS.map((area) => {
            const label = PROVIDER_STATUS_LABELS[providers[area]];
            return (
              <tr key={area}>
                <td>{PROVIDER_AREA_LABELS[area]}</td>
                <td>
                  <Status tone={label.tone}>{label.label}</Status>
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      <Text size="small" tone="muted">
        {SYSTEM_HEALTH_NOTE}
      </Text>
      <Table id="system-health-sweeps" caption="Scheduled database sweeps">
        <thead>
          <tr>
            <th scope="col">Sweep</th>
            <th scope="col">Registered</th>
          </tr>
        </thead>
        <tbody>
          {scheduler.slice(1).map((sweep) => (
            <tr key={sweep.dimension}>
              <td>{SWEEP_LABELS[sweep.dimension as Sweep]}</td>
              <td>
                <Status tone={sweep.value === 1 ? "success" : "warning"}>
                  {sweep.value === 1 ? "Registered" : "Not registered"}
                </Status>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {installed ? null : (
        <Alert tone="warning" title="No database scheduler" role="status">
          The database scheduler is not installed in this database, so no sweep
          runs. Every command still checks its own deadlines; a missing sweep
          only delays clean-up.
        </Alert>
      )}
      <Alert tone="information" title="Hosted checks" role="status">
        {HOSTED_CHECKS_NOTE}
      </Alert>
      <Cluster>
        <ButtonLink variant="secondary" href="/staff/operations">
          Open the operations dashboard
        </ButtonLink>
      </Cluster>
    </StaffFrame>
  );
}
