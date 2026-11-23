// Operations dashboard (MVP-001 S11 pass 2; MBS sections 16 and 18.4; TA
// section 18 "command center").
//
// Rendered on the server for every request. The step-up gate comes first
// (aal2); access then needs the global view_operations grant (the database
// decides again). Counts only, never personal data or the content of a
// matter: background jobs by state with the oldest waiting one, email
// notifications needing attention, open review items by family and
// severity, ready, live and stale consultations, requests awaiting a
// decision, payments in transitional states, profiles under review and
// jurisdictions by lifecycle state. It reads no query, header or cookie.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  resolveOperationsDashboard,
  type SummaryCount,
} from "../../../src/application/operations-workspace.ts";
import { OPERATIONS_WORKSPACE_SOURCES } from "../../../src/infrastructure/staff/operations-adapter.ts";
import {
  ButtonLink,
  Cluster,
  Heading,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import {
  DIMENSION_LABELS,
  FAMILY_LABELS,
  METRIC_TITLES,
  OPERATIONS_INTRO,
  utcText,
} from "../../../src/presentation/operations-labels.ts";
import { requireSteppedUp } from "../../account/gate.ts";
import { BackLink, refusalPage, StaffFrame } from "../frame.tsx";

export const metadata: Metadata = {
  title: "Operations dashboard",
  robots: { index: false, follow: false },
};

const SHOWN = [
  "jobs",
  "notifications",
  "consultations",
  "requests",
  "payments",
  "attorney_profiles",
  "jurisdictions",
] as const;

function dimensionLabel(dimension: string): string {
  const [family, severity] = dimension.split(".");
  return severity === undefined
    ? (DIMENSION_LABELS[dimension] ?? dimension)
    : `${FAMILY_LABELS[family] ?? family}, ${severity}`;
}

function CountTable({
  id,
  title,
  counts,
}: {
  readonly id: string;
  readonly title: string;
  readonly counts: readonly SummaryCount[];
}) {
  return (
    <Table id={id} caption={title}>
      <thead>
        <tr>
          <th scope="col">State</th>
          <th scope="col">Count</th>
          <th scope="col">Oldest</th>
        </tr>
      </thead>
      <tbody>
        {counts.map((count) => (
          <tr key={count.dimension}>
            <td>{dimensionLabel(count.dimension)}</td>
            <td>{count.value}</td>
            <td>{count.oldestAt === null ? "—" : utcText(count.oldestAt)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export default async function OperationsDashboardPage() {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const view = await resolveOperationsDashboard(OPERATIONS_WORKSPACE_SOURCES);
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/operations", "Operations dashboard");
  }
  const { counts } = view.summary;
  return (
    <StaffFrame eyebrow="Operations" title="Operations dashboard">
      <BackLink href="/staff">Staff tools</BackLink>
      <Text tone="muted">{OPERATIONS_INTRO}</Text>
      <Cluster>
        <ButtonLink variant="secondary" href="/staff/jobs">
          Open the job view
        </ButtonLink>
        <ButtonLink variant="secondary" href="/staff/system-health">
          Open system health
        </ButtonLink>
      </Cluster>
      <Heading as="h2" size="md">
        {METRIC_TITLES.review_exceptions}
      </Heading>
      <CountTable
        id="operations-review-exceptions"
        title={METRIC_TITLES.review_exceptions}
        counts={counts.review_exceptions}
      />
      {SHOWN.map((metric) => (
        <CountTable
          key={metric}
          id={`operations-${metric}`}
          title={METRIC_TITLES[metric]}
          counts={counts[metric]}
        />
      ))}
    </StaffFrame>
  );
}
