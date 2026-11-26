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
//
// DEV-001: the owner's UI/UX design (UIUX-HANDOFF-P2 build_p8, Staff.dc.html,
// the Dashboard): the design's headline figures, each one exact count the
// summary answered, above one panel per counted metric with its states,
// counts and oldest entries. Nothing is summed, estimated or sampled.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  resolveOperationsDashboard,
  type SummaryCount,
} from "../../../src/application/operations-workspace.ts";
import { OPERATIONS_WORKSPACE_SOURCES } from "../../../src/infrastructure/staff/operations-adapter.ts";
import {
  DIMENSION_LABELS,
  FAMILY_LABELS,
  METRIC_TITLES,
  OPERATIONS_INTRO,
  utcText,
} from "../../../src/presentation/operations-labels.ts";
import {
  Metric,
  Metrics,
  Panel,
  PanelGrid,
} from "../../../src/presentation/staff-workspace.tsx";
import { requireSteppedUp } from "../../account/gate.ts";
import { refusalPage, StaffFrame } from "../frame.tsx";

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

// The pages a panel's heading links to (the existing job view and system
// health links of this page).
const PANEL_LINKS: Readonly<
  Partial<Record<string, { readonly href: string; readonly label: string }>>
> = {
  jobs: { href: "/staff/jobs", label: "Open the job view" },
};

function dimensionLabel(dimension: string): string {
  const [family, severity] = dimension.split(".");
  return severity === undefined
    ? (DIMENSION_LABELS[dimension] ?? dimension)
    : `${FAMILY_LABELS[family] ?? family}, ${severity}`;
}

// The count the summary answered for one state of one metric.
function countOf(
  counts: Readonly<Record<string, readonly SummaryCount[]>>,
  metric: string,
  dimension: string,
): SummaryCount | null {
  return counts[metric]?.find((count) => count.dimension === dimension) ?? null;
}

function oldestNote(count: SummaryCount | null, none: string): string {
  return count === null || count.oldestAt === null
    ? none
    : `Oldest ${utcText(count.oldestAt)}`;
}

// The design's count table in a panel: each state, its count and its oldest
// entry.
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
    <table className="st-cov" id={id}>
      <caption>{title}</caption>
      <thead>
        <tr>
          <th scope="col">State</th>
          <th scope="col" className="r">
            Count
          </th>
          <th scope="col" className="r">
            Oldest (UTC)
          </th>
        </tr>
      </thead>
      <tbody>
        {counts.map((count) => (
          <tr key={count.dimension}>
            <th scope="row">{dimensionLabel(count.dimension)}</th>
            <td className="r num">{count.value}</td>
            <td className="d num">
              {count.oldestAt === null ? "—" : utcText(count.oldestAt)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
  const awaiting = countOf(counts, "requests", "awaiting_attorney");
  const live = countOf(counts, "consultations", "live");
  const stale = countOf(counts, "consultations", "stale");
  const escalated = countOf(counts, "jobs", "escalated");
  return (
    <StaffFrame
      title="Dashboard"
      subtitle="Operations: counts from the database at the moment this page was loaded."
      lead={<p>{OPERATIONS_INTRO}</p>}
      utc
    >
      <Metrics label="At a glance" count={4}>
        <Metric
          label="Awaiting the attorney"
          value={awaiting?.value ?? "—"}
          note={oldestNote(awaiting, "No request waiting")}
        />
        <Metric
          label="In progress now"
          value={live?.value ?? "—"}
          note={
            live !== null && live.value > 0
              ? "Live now"
              : "No consultation is live"
          }
        />
        <Metric
          label="Need an outcome"
          value={stale?.value ?? "—"}
          note={oldestNote(stale, "None waiting")}
        />
        <Metric
          label="Escalated jobs"
          value={escalated?.value ?? "—"}
          note={oldestNote(escalated, "None escalated")}
          href="/staff/jobs"
        />
      </Metrics>
      <PanelGrid>
        <Panel
          id="operations-review-exceptions-title"
          title={METRIC_TITLES.review_exceptions}
          place="s12"
          link={{ href: "/staff/system-health", label: "Open system health" }}
        >
          <CountTable
            id="operations-review-exceptions"
            title={METRIC_TITLES.review_exceptions}
            counts={counts.review_exceptions}
          />
        </Panel>
        {SHOWN.map((metric) => (
          <Panel
            key={metric}
            id={`operations-${metric}-title`}
            title={METRIC_TITLES[metric]}
            place="s6"
            link={PANEL_LINKS[metric]}
          >
            <CountTable
              id={`operations-${metric}`}
              title={METRIC_TITLES[metric]}
              counts={counts[metric]}
            />
          </Panel>
        ))}
      </PanelGrid>
    </StaffFrame>
  );
}
