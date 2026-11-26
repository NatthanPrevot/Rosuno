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
//
// DEV-001: the owner's UI/UX design (Staff.dc.html, Administration ›
// Settings, system health): the environment in the design's panel, then the
// design's lists of the provider areas and the scheduled sweeps, each with
// its status pill as the server reports it, and the notes on what this view
// does not check.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  PROVIDER_AREAS,
  resolveSystemHealth,
  type Sweep,
} from "../../../src/application/operations-workspace.ts";
import { OPERATIONS_WORKSPACE_SOURCES } from "../../../src/infrastructure/staff/operations-adapter.ts";
import { Alert, Status } from "../../../src/presentation/design-system.tsx";
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
import {
  Cell,
  KeyValues,
  ListBox,
  ListRow,
  Panel,
  PillCell,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { refusalPage, StaffFrame } from "../frame.tsx";

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
    <StaffFrame
      title="Settings"
      subtitle="System health: the recorded environment, the scheduled sweeps and each provider area."
      lead={<p>{SYSTEM_HEALTH_NOTE}</p>}
    >
      <Panel
        id="system-health-environment"
        title="Environment"
        link={{
          href: "/staff/operations",
          label: "Open the operations dashboard",
        }}
      >
        <KeyValues
          items={[
            [
              "Recorded database environment",
              ENVIRONMENT_CLASS_LABELS[summary.environmentClass],
            ],
            [
              "Environment record",
              <Status key="record" tone={status.tone}>
                {status.label}
              </Status>,
            ],
            [
              "This deployment's settings",
              <Status
                key="binding"
                tone={
                  binding === "unrecorded" || binding === "mismatch"
                    ? "error"
                    : "success"
                }
              >
                {ENVIRONMENT_LABELS[binding]}
              </Status>,
            ],
          ]}
        />
      </Panel>
      <h2 className="st-h2">Provider configuration</h2>
      <ListBox label="Provider configuration" columns={["Area", "Settings"]}>
        {PROVIDER_AREAS.map((area) => {
          const label = PROVIDER_STATUS_LABELS[providers[area]];
          return (
            <ListRow key={area} columns={2}>
              <Cell label="Area" strong>
                {PROVIDER_AREA_LABELS[area]}
              </Cell>
              <PillCell label="Settings" tone={label.tone}>
                {label.label}
              </PillCell>
            </ListRow>
          );
        })}
      </ListBox>
      <h2 className="st-h2">Scheduled database sweeps</h2>
      <ListBox
        label="Scheduled database sweeps"
        columns={["Sweep", "Registered"]}
      >
        {scheduler.slice(1).map((sweep) => (
          <ListRow key={sweep.dimension} columns={2}>
            <Cell label="Sweep" strong>
              {SWEEP_LABELS[sweep.dimension as Sweep]}
            </Cell>
            <PillCell
              label="Registered"
              tone={sweep.value === 1 ? "success" : "warning"}
            >
              {sweep.value === 1 ? "Registered" : "Not registered"}
            </PillCell>
          </ListRow>
        ))}
      </ListBox>
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
    </StaffFrame>
  );
}
