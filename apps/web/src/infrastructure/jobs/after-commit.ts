// Server-only after-commit job drain (MVP-001 S2; Packet S2 job
// architecture item 5).
//
// A server action or route handler whose committed domain change enqueued
// an operational job (inside the domain function's own transaction, so the
// job exists exactly when the change committed) calls
// scheduleJobDrainAfterCommit once the change has committed. Next.js runs the
// drain after the response has been sent, bounded to one small batch, so the
// side effect usually follows at once without delaying the response. Nothing
// depends on it: if it cannot be scheduled, or the drain finds nothing to
// claim, the job stays pending and visible until the protected worker route
// drains the backlog.
//
// S2 has no action that enqueues a job (the provider job types arrive with
// S3, S4, and S10), so nothing calls this yet.

import {
  AFTER_COMMIT_BOUNDS,
  drainOperationalJobs,
  type DrainBounds,
  type OperationalDrainResult,
} from "./job-worker-adapter.ts";

export type AfterResponse = (task: () => Promise<void>) => void;

// Schedules one bounded drain after the current response. It answers
// whether the drain was scheduled, and never throws: outside a request, or
// when the runtime refuses, nothing runs and nothing is lost.
export async function scheduleJobDrainAfterCommit(
  schedule?: AfterResponse,
  drain: (
    bounds: DrainBounds,
  ) => Promise<OperationalDrainResult> = drainOperationalJobs,
): Promise<boolean> {
  try {
    const afterResponse: AfterResponse =
      schedule ?? (await import("next/server")).after;
    afterResponse(async () => {
      await drain(AFTER_COMMIT_BOUNDS);
    });
    return true;
  } catch {
    return false;
  }
}
