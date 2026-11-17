// Operational jobs (MVP-001 S2; Packet S2 job architecture item 5).
//
// Rendered on the server for every request. A fresh staff identity and the
// database's own capability predicate decide access: the view needs the
// global manage_operational_jobs capability, exactly as the table's row
// policy and the staff job functions do. One group of states is listed at a
// time, one page at a time: escalated jobs first, then the jobs still waiting
// or running (a job past its due time or lease is marked as waiting for a
// worker run, so a missing trigger is visible here), then the finished ones.
// Each row shows the job type, the subject type and id, the state, the
// attempts, the last error code, and the times; never a subject's data or an
// error message. An escalated job can be retried and an unfinished one
// cancelled; the database decides again and audits each change. The two
// query values read, state and page, only choose the group and the page; the
// server checks both.

import type { Metadata } from "next";
import { connection } from "next/server";

import {
  JOB_GROUPS,
  resolveOperationalJobs,
  type JobRow,
} from "../../../src/application/staff-configuration.ts";
import { STAFF_CONFIGURATION_SOURCES } from "../../../src/infrastructure/staff/staff-configuration-adapter.ts";
import {
  ButtonLink,
  Cluster,
  Stack,
  Status,
  Table,
  Text,
} from "../../../src/presentation/design-system.tsx";
import {
  JOB_GROUP_LINKS,
  JOB_STATE_LABELS,
  utcDateTime,
} from "../../../src/presentation/staff-configuration-labels.ts";
import { requireSteppedUp } from "../../account/gate.ts";
import { BackLink, PagerLinks, refusalPage, StaffFrame } from "../frame.tsx";
import { CancelJobForm, RetryJobForm } from "./forms.tsx";

export const metadata: Metadata = {
  title: "Operational jobs",
  robots: { index: false, follow: false },
};

const EMPTY_GROUP = Object.freeze({
  escalated: "There are no escalated jobs.",
  open: "There are no waiting or running jobs.",
  finished: "There are no finished jobs.",
});

// When the job is due, holds its lease, finished, or was escalated.
function timing(job: JobRow): string {
  switch (job.state) {
    case "pending":
      return job.waiting
        ? `Due since ${utcDateTime(job.availableAt)}; waiting for a worker run`
        : `Due at ${utcDateTime(job.availableAt)}`;
    case "running":
      return job.waiting
        ? `Lease expired at ${utcDateTime(job.availableAt)}; waiting for a worker run`
        : `Running since ${utcDateTime(job.lockedAt ?? job.createdAt)}; lease until ${utcDateTime(job.availableAt)}`;
    case "completed":
      return `Completed at ${utcDateTime(job.completedAt ?? job.createdAt)}`;
    case "escalated":
      return `Escalated at ${utcDateTime(job.failedAt ?? job.createdAt)}`;
    case "cancelled":
      return "Cancelled";
  }
}

export default async function OperationalJobsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly state?: string | string[];
    readonly page?: string | string[];
  }>;
}) {
  // Access belongs to each request on the server; never prerender or cache it.
  await connection();
  await requireSteppedUp("staff");
  const { state, page } = await searchParams;
  const view = await resolveOperationalJobs(
    STAFF_CONFIGURATION_SOURCES,
    state,
    page,
  );
  if (view.status !== "ready") {
    return refusalPage(view, "/staff/jobs", "Operational jobs");
  }
  const current = JOB_GROUP_LINKS[view.group];
  return (
    <StaffFrame eyebrow="Staff" title="Operational jobs">
      <BackLink href="/staff">Staff tools</BackLink>
      <Text tone="muted">
        Background jobs carry out side effects after the change that needs them
        is saved. A failed attempt is retried after a delay, and a job whose
        attempts are used up is escalated here. A job past its due time waits
        until the next worker run picks it up.
      </Text>
      <Cluster>
        {JOB_GROUPS.map((group) => (
          <ButtonLink
            key={group}
            variant={group === view.group ? "primary" : "secondary"}
            href={JOB_GROUP_LINKS[group].href}
            aria-current={group === view.group ? "page" : undefined}
          >
            {JOB_GROUP_LINKS[group].title}
          </ButtonLink>
        ))}
      </Cluster>
      {view.jobs.length === 0 ? (
        <Text>
          {view.pager.page === 1
            ? EMPTY_GROUP[view.group]
            : "There are no jobs on this page."}
        </Text>
      ) : (
        <Table id="operational-jobs" caption={`${current.title} jobs`}>
          <thead>
            <tr>
              <th scope="col">Job type</th>
              <th scope="col">Subject</th>
              <th scope="col">State</th>
              <th scope="col">Attempts</th>
              <th scope="col">Last error</th>
              <th scope="col">Times</th>
              <th scope="col">Change</th>
            </tr>
          </thead>
          <tbody>
            {view.jobs.map((job) => (
              <tr key={job.id}>
                <td>{job.jobType}</td>
                <td>
                  {job.subjectType === null ? (
                    "None"
                  ) : (
                    <Stack gap="tight">
                      <span>{job.subjectType}</span>
                      <Text size="small" tone="muted">
                        {job.subjectId}
                      </Text>
                    </Stack>
                  )}
                </td>
                <td>
                  <Status tone={JOB_STATE_LABELS[job.state].tone}>
                    {JOB_STATE_LABELS[job.state].label}
                  </Status>
                </td>
                <td>{`${job.attempts} of ${job.maxAttempts}`}</td>
                <td>{job.lastErrorCode ?? "None"}</td>
                <td>
                  <Stack gap="tight">
                    <span>{timing(job)}</span>
                    <Text size="small" tone="muted">
                      {`Created at ${utcDateTime(job.createdAt)}`}
                    </Text>
                  </Stack>
                </td>
                <td>
                  {job.canRetry || job.canCancel ? (
                    <Stack gap="tight">
                      {job.canRetry ? <RetryJobForm job={job.id} /> : null}
                      {job.canCancel ? <CancelJobForm job={job.id} /> : null}
                    </Stack>
                  ) : (
                    "None"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <PagerLinks
        pager={view.pager}
        base={current.href}
        noun="jobs"
        shown={view.jobs.length}
      />
    </StaffFrame>
  );
}
