// Server-only operational job worker wiring (MVP-001 S2; Packet S2 job
// architecture items 4 and 5).
//
// Joins the provider-neutral drain to its three trusted inputs: the
// privileged worker port (built only from the verified project binding, in
// the one module that reads the privileged credential), the production
// handler registry, and the server clock. It also decides whether a request
// to the protected worker route may run a drain at all.
//
// The worker route is protected by one server-only setting,
// ROSUNO_JOB_WORKER_SECRET, read through the provider configuration reader:
// unset, empty, a recognizable placeholder, or anything but 32 to 128
// letters, digits, underscores, or hyphens means the route is unavailable
// and nothing runs. (A hexadecimal value never resembles a placeholder.) A
// request must present exactly "Bearer <value>"; both the presented value
// and the configured one are reduced to SHA-256 digests of equal length and
// compared in constant time, so neither the answer nor its timing depends on
// how much of the value was right. Nothing the request carries is logged or
// echoed: a refusal writes one line naming only the outcome.
//
// Each drain uses its own worker identity, so its reports can never complete
// or fail another drain's claims. Every batch writes one line with its
// counts, and every reported failure, unconfirmed completion, and unknown
// claim one line with the job type, the fixed error code, and the database's
// answer; never a subject, payload, or message.
//
// The hosted trigger for the worker route is not configured (Packet rule 14,
// Replit HOLD). Until it is, due jobs wait: a pending job past its due time
// stays visible in the staff job view until a drain runs.

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import {
  drainJobs,
  type JobDrainCounts,
  type JobDrainResult,
  type JobHandler,
  type JobHandlers,
  type JobWorkerPort,
} from "../../application/job-worker.ts";
import {
  readProviderConfiguration,
  type ProviderSetting,
} from "../environment/provider-configuration.ts";
import { createJobWorkerPort } from "../identity/registration-provisioning.ts";
import { logRequestEvent } from "../observability/request-log.ts";

// The production handler registry: job type -> handler. It is EMPTY in S2.
// The provider job types (Storage, scheduling and communications side
// effects) and their handlers arrive with the slices that introduce them
// (S3, S4, S10). Until then every claimed job is reported unknown_job_type,
// retried with backoff, and escalated visibly when its attempts are used up.
export const PRODUCTION_JOB_HANDLERS: JobHandlers = new Map<
  string,
  JobHandler
>();

// The one setting that protects the worker route.
export const JOB_WORKER_SETTING: ProviderSetting = Object.freeze({
  name: "ROSUNO_JOB_WORKER_SECRET",
  pattern: /^[A-Za-z0-9_-]{32,128}$/,
});

type Environment = Readonly<Record<string, string | undefined>>;

// The configured worker value, or null when it is not configured or is
// refused. The value is returned only to the comparison below.
export function readJobWorkerValue(environment?: Environment): string | null {
  const configuration =
    environment === undefined
      ? readProviderConfiguration([JOB_WORKER_SETTING])
      : readProviderConfiguration([JOB_WORKER_SETTING], environment);
  if (configuration.kind !== "configured") {
    return null;
  }
  const value = configuration.values[JOB_WORKER_SETTING.name];
  return typeof value === "string" ? value : null;
}

// Exactly one bearer value of visible ASCII; anything longer is refused
// before it is hashed.
const BEARER = /^Bearer ([\x21-\x7e]{1,256})$/;
const MAX_HEADER_LENGTH = 300;

function digestOf(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

// Whether the Authorization header presents the configured value. The
// comparison always runs, on two 32-byte digests, in constant time.
export function isAuthorizedWorkerRequest(
  authorization: string | null,
  configured: string,
): boolean {
  const presented =
    typeof authorization === "string" &&
    authorization.length <= MAX_HEADER_LENGTH
      ? BEARER.exec(authorization)?.[1]
      : undefined;
  const equal = timingSafeEqual(
    digestOf(presented ?? ""),
    digestOf(configured),
  );
  return presented !== undefined && configured !== "" && equal;
}

// The drain settings shared by every drain. Every claimed job's lease (two
// minutes) outlasts its claim answer, its handler, and its report.
const LEASE_SECONDS = 120;
const HANDLER_DEADLINE_MS = 30_000;
const CALL_DEADLINE_MS = 10_000;
const BUDGET_MS = 45_000;

export type DrainBounds = {
  readonly batchLimit: number;
  readonly maxBatches: number;
};

// The worker route drains the backlog: up to five batches of ten.
export const WORKER_ROUTE_BOUNDS: DrainBounds = Object.freeze({
  batchLimit: 10,
  maxBatches: 5,
});

// An after-commit drain runs one small batch.
export const AFTER_COMMIT_BOUNDS: DrainBounds = Object.freeze({
  batchLimit: 5,
  maxBatches: 1,
});

export type OperationalDrainResult = JobDrainCounts & {
  readonly status: JobDrainResult["status"] | "unavailable";
};

const UNAVAILABLE_DRAIN: OperationalDrainResult = Object.freeze({
  status: "unavailable",
  batches: 0,
  claimed: 0,
  completed: 0,
  retried: 0,
  escalated: 0,
  superseded: 0,
  unconfirmed: 0,
  claimFailures: 0,
});

export type JobWorkerWiring = {
  readonly port: () => Promise<JobWorkerPort | null>;
  readonly handlers: JobHandlers;
  readonly clock: () => number;
  readonly workerId: () => string;
};

export const JOB_WORKER_WIRING: JobWorkerWiring = Object.freeze({
  port: () => createJobWorkerPort(),
  handlers: PRODUCTION_JOB_HANDLERS,
  clock: () => Date.now(),
  workerId: () => `rosuno-web:${randomUUID()}`,
});

// Runs one bounded drain. Without a verified project binding nothing is
// claimed and the drain is unavailable. It never throws.
export async function drainOperationalJobs(
  bounds: DrainBounds = WORKER_ROUTE_BOUNDS,
  wiring: JobWorkerWiring = JOB_WORKER_WIRING,
): Promise<OperationalDrainResult> {
  try {
    const port = await wiring.port();
    if (port === null) {
      await logRequestEvent("warn", "operational_jobs.worker_unavailable", {
        outcome: "unbound",
      });
      return UNAVAILABLE_DRAIN;
    }
    return await drainJobs({
      port,
      handlers: wiring.handlers,
      settings: Object.freeze({
        workerId: wiring.workerId(),
        leaseSeconds: LEASE_SECONDS,
        batchLimit: bounds.batchLimit,
        maxBatches: bounds.maxBatches,
        handlerDeadlineMs: HANDLER_DEADLINE_MS,
        callDeadlineMs: CALL_DEADLINE_MS,
        budgetMs: BUDGET_MS,
      }),
      clock: wiring.clock,
      observer: Object.freeze({
        batch: (counts) =>
          logRequestEvent("info", "operational_jobs.batch", {
            claimed: counts.claimed,
            completed: counts.completed,
            retried: counts.retried,
            escalated: counts.escalated,
            superseded: counts.superseded,
            unconfirmed: counts.unconfirmed,
          }),
        failureReported: (jobType, errorCode, outcome) =>
          logRequestEvent("warn", "operational_jobs.job_failed", {
            jobType,
            errorCode,
            outcome,
          }),
        completionUnconfirmed: (jobType, outcome) =>
          logRequestEvent("warn", "operational_jobs.completion_unconfirmed", {
            jobType,
            outcome,
          }),
        claimFailed: () =>
          logRequestEvent("warn", "operational_jobs.claim_failed", {
            outcome: "unknown",
          }),
      }),
    });
  } catch {
    return UNAVAILABLE_DRAIN;
  }
}

// One answer of the worker route: an HTTP status and a body of fixed words
// and counts only.
export type JobWorkerResponse = {
  readonly status: 200 | 401 | 503;
  readonly body: Readonly<Record<string, string | number>>;
};

export type JobWorkerRequestSources = {
  readonly configured: () => string | null;
  readonly drain: () => Promise<OperationalDrainResult>;
};

export const JOB_WORKER_REQUEST_SOURCES: JobWorkerRequestSources =
  Object.freeze({
    configured: () => readJobWorkerValue(),
    drain: () => drainOperationalJobs(WORKER_ROUTE_BOUNDS),
  });

const UNAVAILABLE_RESPONSE: JobWorkerResponse = Object.freeze({
  status: 503,
  body: Object.freeze({ status: "unavailable" }),
});
const UNAUTHORIZED_RESPONSE: JobWorkerResponse = Object.freeze({
  status: 401,
  body: Object.freeze({ status: "unauthorized" }),
});

// Decides one worker route request: unavailable (nothing runs) without a
// configured value, unauthorized without exactly the configured bearer
// value, and otherwise one bounded drain answered by its counts. It never
// throws.
export async function handleJobWorkerRequest(
  authorization: string | null,
  sources: JobWorkerRequestSources = JOB_WORKER_REQUEST_SOURCES,
): Promise<JobWorkerResponse> {
  try {
    const configured = sources.configured();
    if (configured === null) {
      await logRequestEvent("warn", "operational_jobs.worker_refused", {
        outcome: "unconfigured",
      });
      return UNAVAILABLE_RESPONSE;
    }
    if (!isAuthorizedWorkerRequest(authorization, configured)) {
      await logRequestEvent("warn", "operational_jobs.worker_refused", {
        outcome: "unauthorized",
      });
      return UNAUTHORIZED_RESPONSE;
    }
    const result = await sources.drain();
    if (result.status !== "ran") {
      return UNAVAILABLE_RESPONSE;
    }
    return Object.freeze({
      status: 200,
      body: Object.freeze({
        status: "ran",
        batches: result.batches,
        claimed: result.claimed,
        completed: result.completed,
        retried: result.retried,
        escalated: result.escalated,
        superseded: result.superseded,
        unconfirmed: result.unconfirmed,
        claimFailures: result.claimFailures,
      }),
    });
  } catch {
    return UNAVAILABLE_RESPONSE;
  }
}
