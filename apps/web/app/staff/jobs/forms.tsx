"use client";

// Operational job forms (MVP-001 S2).
//
// Each form names only the job it concerns. The server re-checks the
// caller's step-up, identity, and capability before anything is sent, and
// the database decides again whether the job's current state allows the
// change, and audits it.

import {
  Button,
  Cluster,
  Stack,
} from "../../../src/presentation/design-system.tsx";
import {
  cancelOperationalJobAction,
  retryOperationalJobAction,
} from "../actions.ts";
import { Outcome, useConfigurationAction } from "../outcome.tsx";

export function RetryJobForm({ job }: { readonly job: string }) {
  const [state, formAction, pending] = useConfigurationAction(
    retryOperationalJobAction,
  );
  return (
    <form action={formAction}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="job" value={job} />
        <Cluster>
          <Button variant="secondary" type="submit" disabled={pending}>
            Retry this job
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}

export function CancelJobForm({ job }: { readonly job: string }) {
  const [state, formAction, pending] = useConfigurationAction(
    cancelOperationalJobAction,
  );
  return (
    <form action={formAction}>
      <Stack gap="tight">
        <Outcome state={state} />
        <input type="hidden" name="job" value={job} />
        <Cluster>
          <Button variant="tertiary" type="submit" disabled={pending}>
            Cancel this job
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
