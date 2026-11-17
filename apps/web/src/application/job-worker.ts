// Operational job worker (MVP-001 S2; Packet S2 job architecture items 4
// and 5; MBS section 21; TA sections 23, 27 and 72).
//
// Provider-neutral and injectable. One claim-based worker in the server
// runtime performs the provider side effects that domain functions record in
// the operational job outbox. A drain claims due jobs in bounded batches
// through the worker port (the database's own job_claim, with skip-locked
// claims, a lease, and bounded attempts), runs each claimed job's handler
// under a deadline with a deterministic idempotency key, and reports the
// attempt with job_complete or job_fail. The database decides everything
// else: the retry backoff, escalation when attempts are exhausted (visible to
// staff, with an audit event), lease expiry and reclamation, and that a
// duplicate report changes nothing.
//
// The rules here:
// - only a handler that resolves to exactly JOB_DONE succeeded; a handler
//   that throws, rejects, resolves to anything else, or runs past its
//   deadline failed, and the failure is reported with one fixed error code
//   and one fixed message (never personal data or a provider payload);
// - a job whose type has no handler is reported as unknown_job_type, so the
//   database retries it with backoff and escalates it visibly;
// - the idempotency key of a job is the same on every attempt and every
//   delivery (rosuno-job-<job id>), so a handler that passes it to its
//   provider never repeats an effect when a job is delivered again (after a
//   lost answer, an expired lease, or a staff retry);
// - an answer that is lost, late, or not one of the function's own outcomes
//   is never counted as completed or reported: it is unconfirmed, the lease
//   expires, and the job is claimed again;
// - a drain never throws and returns counts only.
//
// No handler is defined here, and the production registry is empty in S2
// (the provider job types arrive with S3, S4 and S10). Synthetic handlers
// exist only in tests.

import { isUuid, readExact } from "./professional-records.ts";

// ---------------------------------------------------------------------------
// Vocabulary and bounds (the database checks every bound again)
// ---------------------------------------------------------------------------

// The fixed error codes a drain reports. Each matches the database's
// lower-snake error code format.
export const JOB_ERROR_CODES = Object.freeze([
  "handler_failed",
  "handler_timeout",
  "unknown_job_type",
] as const);
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

// One fixed, bounded message per error code: no personal data, provider
// payload, or error text ever reaches the job record.
export const JOB_ERROR_MESSAGES: Readonly<Record<JobErrorCode, string>> =
  Object.freeze({
    handler_failed: "The job handler reported a failure.",
    handler_timeout: "The job handler did not finish within its deadline.",
    unknown_job_type: "No handler is registered for this job type.",
  });

// job_complete's and job_fail's own outcomes.
export const COMPLETE_OUTCOMES = Object.freeze([
  "completed",
  "not_owner",
  "not_running",
] as const);
export const FAIL_OUTCOMES = Object.freeze([
  "retry_scheduled",
  "escalated",
  "not_owner",
  "not_running",
] as const);
export type CompleteAnswer = (typeof COMPLETE_OUTCOMES)[number] | "unknown";
export type FailAnswer = (typeof FAIL_OUTCOMES)[number] | "unknown";

const WORKER_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const JOB_TYPE = /^[a-z][a-z0-9_.]{2,63}$/;
const SUBJECT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
// The database keeps at most this many characters of a message.
export const JOB_ERROR_MESSAGE_MAX = 500;
// The database's own bounds: leases of 5 to 3600 seconds, claims of 1 to 50
// jobs, and 1 to 25 attempts per enqueued job (raised only by staff retry).
const LEASE_MIN_SECONDS = 5;
const LEASE_MAX_SECONDS = 3600;
const CLAIM_MAX = 50;
const ATTEMPT_MAX = 1_000_000;
// A drain's own bounds.
const BATCHES_MAX = 20;
const HANDLER_DEADLINE_MAX_MS = 600_000;
const CALL_DEADLINE_MAX_MS = 60_000;
const BUDGET_MAX_MS = 600_000;

function isIntegerIn(value: unknown, min: number, max: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
  );
}

export function isWorkerId(value: unknown): value is string {
  return typeof value === "string" && WORKER_ID.test(value);
}

export function isLeaseSeconds(value: unknown): value is number {
  return isIntegerIn(value, LEASE_MIN_SECONDS, LEASE_MAX_SECONDS);
}

export function isClaimLimit(value: unknown): value is number {
  return isIntegerIn(value, 1, CLAIM_MAX);
}

export function isJobErrorCode(value: unknown): value is string {
  return typeof value === "string" && ERROR_CODE.test(value);
}

export function isJobErrorMessage(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length >= 1 &&
      value.length <= JOB_ERROR_MESSAGE_MAX)
  );
}

// The deterministic idempotency key of a job: the same on every attempt and
// every delivery of that job, and different for every other job.
export function idempotencyKeyOf(jobId: string): string {
  return `rosuno-job-${jobId}`;
}

// ---------------------------------------------------------------------------
// The worker port and its answers
// ---------------------------------------------------------------------------

export type ClaimedJob = {
  readonly jobId: string;
  readonly jobType: string;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly attempt: number;
  readonly maxAttempts: number;
};

export type ClaimAnswer =
  | { readonly kind: "claimed"; readonly jobs: readonly ClaimedJob[] }
  | { readonly kind: "unknown" };

export const UNKNOWN_CLAIM: ClaimAnswer = Object.freeze({ kind: "unknown" });

// The three worker calls, each one fixed database function. A port answers
// "unknown" for anything it cannot read strictly; it never throws.
export type JobWorkerPort = {
  readonly claim: (
    workerId: string,
    leaseSeconds: number,
    limit: number,
  ) => Promise<ClaimAnswer>;
  readonly complete: (
    jobId: string,
    workerId: string,
  ) => Promise<CompleteAnswer>;
  readonly fail: (
    jobId: string,
    workerId: string,
    errorCode: string,
    errorMessage: string | null,
  ) => Promise<FailAnswer>;
};

const CLAIM_COLUMNS = Object.freeze([
  "job_id",
  "job_type",
  "subject_type",
  "subject_id",
  "attempt",
  "max_attempts",
]);

function claimedJobOf(row: unknown): ClaimedJob | null {
  const fields = readExact(row, CLAIM_COLUMNS);
  if (fields === null) {
    return null;
  }
  const jobId = fields.get("job_id");
  const jobType = fields.get("job_type");
  const subjectType = fields.get("subject_type");
  const subjectId = fields.get("subject_id");
  const attempt = fields.get("attempt");
  const maxAttempts = fields.get("max_attempts");
  if (
    !isUuid(jobId) ||
    typeof jobType !== "string" ||
    !JOB_TYPE.test(jobType) ||
    (subjectType === null) !== (subjectId === null) ||
    (subjectType !== null &&
      (typeof subjectType !== "string" || !SUBJECT_TYPE.test(subjectType))) ||
    (subjectId !== null && !isUuid(subjectId)) ||
    !isIntegerIn(maxAttempts, 1, ATTEMPT_MAX) ||
    !isIntegerIn(attempt, 1, maxAttempts as number)
  ) {
    return null;
  }
  return Object.freeze({
    jobId,
    jobType,
    subjectType: subjectType as string | null,
    subjectId: subjectId as string | null,
    attempt: attempt as number,
    maxAttempts: maxAttempts as number,
  });
}

// job_claim's answer read strictly: at most the limit asked for, each row
// exactly the function's six columns with their own shapes, and no job twice.
// Anything else is unknown.
export function claimAnswerOf(data: unknown, limit: number): ClaimAnswer {
  if (!Array.isArray(data) || !isClaimLimit(limit) || data.length > limit) {
    return UNKNOWN_CLAIM;
  }
  const jobs: ClaimedJob[] = [];
  const seen = new Set<string>();
  for (const row of data) {
    const job = claimedJobOf(row);
    if (job === null || seen.has(job.jobId)) {
      return UNKNOWN_CLAIM;
    }
    seen.add(job.jobId);
    jobs.push(job);
  }
  return Object.freeze({ kind: "claimed", jobs: Object.freeze(jobs) });
}

export function completeAnswerOf(data: unknown): CompleteAnswer {
  return typeof data === "string" &&
    (COMPLETE_OUTCOMES as readonly string[]).includes(data)
    ? (data as CompleteAnswer)
    : "unknown";
}

export function failAnswerOf(data: unknown): FailAnswer {
  return typeof data === "string" &&
    (FAIL_OUTCOMES as readonly string[]).includes(data)
    ? (data as FailAnswer)
    : "unknown";
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// The one value a handler resolves to when its effect is done.
export const JOB_DONE = "done";

// What a handler is given: the claimed job, its idempotency key, and a
// signal that is aborted when its deadline passes.
export type JobRun = ClaimedJob & {
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
};

export type JobHandler = (job: JobRun) => Promise<typeof JOB_DONE>;

// The handler registry: job type -> handler.
export type JobHandlers = ReadonlyMap<string, JobHandler>;

// ---------------------------------------------------------------------------
// The drain
// ---------------------------------------------------------------------------

export type JobWorkerSettings = {
  // This drain's worker identity (database format); each drain uses its own.
  readonly workerId: string;
  // The lease each claim takes (5 to 3600 seconds).
  readonly leaseSeconds: number;
  // The most jobs one claim takes (1 to 50).
  readonly batchLimit: number;
  // The most batches one drain claims (1 to 20).
  readonly maxBatches: number;
  // How long one handler may run.
  readonly handlerDeadlineMs: number;
  // How long one worker call may take before its answer counts as lost.
  readonly callDeadlineMs: number;
  // No further batch is claimed once this much time has passed.
  readonly budgetMs: number;
};

export type JobDrainCounts = {
  readonly batches: number;
  readonly claimed: number;
  readonly completed: number;
  readonly retried: number;
  readonly escalated: number;
  readonly superseded: number;
  readonly unconfirmed: number;
  readonly claimFailures: number;
};

// "ran": the drain ran within its settings (its counts say what happened).
// "refused": the settings are outside their bounds, so nothing was claimed.
export type JobDrainResult = JobDrainCounts & {
  readonly status: "ran" | "refused";
};

export type JobBatchCounts = Omit<JobDrainCounts, "batches" | "claimFailures">;

// What a drain tells its observer: one note per batch, one per failed
// attempt it reported (the job type, the fixed error code, and the
// database's answer), one per completion it could not confirm, and one per
// claim whose answer was unknown. Only job types, codes, answers, and counts
// are ever passed.
export type JobWorkerObserver = {
  readonly batch?: (counts: JobBatchCounts) => void | Promise<void>;
  readonly failureReported?: (
    jobType: string,
    errorCode: JobErrorCode,
    answer: FailAnswer,
  ) => void | Promise<void>;
  readonly completionUnconfirmed?: (
    jobType: string,
    answer: CompleteAnswer,
  ) => void | Promise<void>;
  readonly claimFailed?: () => void | Promise<void>;
};

export type JobWorkerRun = {
  readonly port: JobWorkerPort;
  readonly handlers: JobHandlers;
  readonly settings: JobWorkerSettings;
  readonly clock: () => number;
  readonly observer?: JobWorkerObserver;
};

type JobOutcome =
  "completed" | "retried" | "escalated" | "superseded" | "unconfirmed";

const ZERO: JobDrainCounts = Object.freeze({
  batches: 0,
  claimed: 0,
  completed: 0,
  retried: 0,
  escalated: 0,
  superseded: 0,
  unconfirmed: 0,
  claimFailures: 0,
});

export const REFUSED_DRAIN: JobDrainResult = Object.freeze({
  status: "refused",
  ...ZERO,
});

// Whether the settings are within their bounds, and every claimed job's
// lease outlasts its claim answer, its handler, and its report.
export function areJobWorkerSettings(settings: unknown): boolean {
  const fields = readExact(settings, [
    "workerId",
    "leaseSeconds",
    "batchLimit",
    "maxBatches",
    "handlerDeadlineMs",
    "callDeadlineMs",
    "budgetMs",
  ]);
  if (fields === null) {
    return false;
  }
  const lease = fields.get("leaseSeconds");
  const handler = fields.get("handlerDeadlineMs");
  const call = fields.get("callDeadlineMs");
  return (
    isWorkerId(fields.get("workerId")) &&
    isLeaseSeconds(lease) &&
    isClaimLimit(fields.get("batchLimit")) &&
    isIntegerIn(fields.get("maxBatches"), 1, BATCHES_MAX) &&
    isIntegerIn(handler, 1, HANDLER_DEADLINE_MAX_MS) &&
    isIntegerIn(call, 1, CALL_DEADLINE_MAX_MS) &&
    isIntegerIn(fields.get("budgetMs"), 0, BUDGET_MAX_MS) &&
    (handler as number) + 2 * (call as number) < (lease as number) * 1000
  );
}

// Runs work under a deadline: its answer, or the fallback when it throws,
// rejects, or is still running at the deadline.
async function withinDeadline<T>(
  work: () => Promise<T>,
  fallback: T,
  deadlineMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), deadlineMs);
  });
  try {
    return await Promise.race([work(), expired]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

// An observer note never changes or interrupts a drain.
async function note(call: () => void | Promise<void>): Promise<void> {
  try {
    await call();
  } catch {
    // Observation is best effort.
  }
}

const TIMED_OUT = Symbol("timed out");

// Runs one handler under its deadline: null when it resolved to exactly
// JOB_DONE in time, otherwise the error code to report. On the deadline its
// signal is aborted; anything it does later is covered by its idempotency
// key when the job is attempted again.
async function runHandler(
  handler: JobHandler,
  job: ClaimedJob,
  deadlineMs: number,
): Promise<JobErrorCode | null> {
  const controller = new AbortController();
  const run: JobRun = Object.freeze({
    ...job,
    idempotencyKey: idempotencyKeyOf(job.jobId),
    signal: controller.signal,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(TIMED_OUT);
    }, deadlineMs);
  });
  const work = (async () => {
    try {
      return (await handler(run)) === JOB_DONE;
    } catch {
      return false;
    }
  })();
  try {
    const result = await Promise.race([work, expired]);
    if (result === TIMED_OUT) {
      return "handler_timeout";
    }
    return result ? null : "handler_failed";
  } finally {
    clearTimeout(timer);
  }
}

async function processJob(
  job: ClaimedJob,
  run: JobWorkerRun,
): Promise<JobOutcome> {
  const { port, handlers, settings, observer } = run;
  const handler = handlers.get(job.jobType);
  const failure =
    handler === undefined
      ? "unknown_job_type"
      : await runHandler(handler, job, settings.handlerDeadlineMs);
  if (failure === null) {
    const answer = completeAnswerOf(
      await withinDeadline(
        () => port.complete(job.jobId, settings.workerId),
        "unknown",
        settings.callDeadlineMs,
      ),
    );
    if (answer === "completed") {
      return "completed";
    }
    if (answer === "unknown") {
      await note(() => observer?.completionUnconfirmed?.(job.jobType, answer));
      return "unconfirmed";
    }
    return "superseded";
  }
  const answer = failAnswerOf(
    await withinDeadline(
      () =>
        port.fail(
          job.jobId,
          settings.workerId,
          failure,
          JOB_ERROR_MESSAGES[failure],
        ),
      "unknown",
      settings.callDeadlineMs,
    ),
  );
  await note(() => observer?.failureReported?.(job.jobType, failure, answer));
  switch (answer) {
    case "retry_scheduled":
      return "retried";
    case "escalated":
      return "escalated";
    case "unknown":
      return "unconfirmed";
    default:
      return "superseded";
  }
}

// Claims and runs due jobs in bounded batches. A batch's jobs run side by
// side, so every job's lease covers its own handler and report. The drain
// stops after the last batch allowed, a batch smaller than the limit (no
// more due work), a claim whose answer is unknown, or once its time budget
// has passed.
export async function drainJobs(run: JobWorkerRun): Promise<JobDrainResult> {
  const totals: Record<keyof JobDrainCounts, number> = { ...ZERO };
  try {
    if (!areJobWorkerSettings(run.settings)) {
      return REFUSED_DRAIN;
    }
    const { port, settings, clock, observer } = run;
    const started = clock();
    for (let batch = 0; batch < settings.maxBatches; batch += 1) {
      if (batch > 0 && clock() - started >= settings.budgetMs) {
        break;
      }
      const claim = await withinDeadline(
        () =>
          port.claim(
            settings.workerId,
            settings.leaseSeconds,
            settings.batchLimit,
          ),
        UNKNOWN_CLAIM,
        settings.callDeadlineMs,
      );
      const jobs = claimedJobsOf(claim, settings.batchLimit);
      if (jobs === null) {
        totals.claimFailures += 1;
        await note(() => observer?.claimFailed?.());
        break;
      }
      totals.batches += 1;
      const outcomes = await Promise.all(
        jobs.map((job) => processJob(job, run)),
      );
      const counts: Record<keyof JobBatchCounts, number> = {
        claimed: jobs.length,
        completed: 0,
        retried: 0,
        escalated: 0,
        superseded: 0,
        unconfirmed: 0,
      };
      for (const outcome of outcomes) {
        counts[outcome] += 1;
      }
      for (const key of Object.keys(counts) as (keyof JobBatchCounts)[]) {
        totals[key] += counts[key];
      }
      await note(() => observer?.batch?.(Object.freeze({ ...counts })));
      if (jobs.length < settings.batchLimit) {
        break;
      }
    }
  } catch {
    // Nothing above throws; should it, the counts so far still stand.
  }
  return Object.freeze({ status: "ran", ...totals });
}

// The jobs of a claim answer the drain can trust, or null: a port that
// answers anything but a strictly read claim within the limit is not trusted.
function claimedJobsOf(
  claim: unknown,
  limit: number,
): readonly ClaimedJob[] | null {
  const fields = readExact(claim, ["kind", "jobs"]);
  if (fields === null || fields.get("kind") !== "claimed") {
    return null;
  }
  const jobs = fields.get("jobs");
  if (!Array.isArray(jobs) || jobs.length > limit) {
    return null;
  }
  const seen = new Set<string>();
  for (const job of jobs) {
    const id = readExact(job, [
      "jobId",
      "jobType",
      "subjectType",
      "subjectId",
      "attempt",
      "maxAttempts",
    ])?.get("jobId");
    if (!isUuid(id) || seen.has(id)) {
      return null;
    }
    seen.add(id);
  }
  return jobs as readonly ClaimedJob[];
}
