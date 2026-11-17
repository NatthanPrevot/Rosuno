"use server";

// Attorney schedule server actions (MVP-001 S4).
//
// Each action first asks the step-up gate (MVP-001 S2); a session that is not
// stepped up gets one fixed refusal and nothing is handed to the use case.
// Otherwise it hands the submitted form and this request's trusted ports to
// the application boundary, which re-establishes the attorney principal on
// the server and calls one database function through the request's own
// session; the database decides again. Next.js accepts these only as POST
// requests and applies its Server Action origin checks. The previous state
// comes back from the browser and is never read. Nothing the caller sends
// chooses an identity, profile, deadline or availability: a submitted id only
// names which of the attorney's own rules or Blackouts a change concerns, and
// the heartbeat sends nothing at all.

import { revalidatePath } from "next/cache";

import {
  createAvailabilityRule,
  createBlackout,
  deactivateAvailabilityRule,
  observeScheduleSession,
  removeBlackout,
  switchInstantMode,
  type HeartbeatState,
  type ScheduleActionState,
} from "../../../src/application/attorney-schedule.ts";
import { ATTORNEY_SCHEDULE_SOURCES } from "../../../src/infrastructure/scheduling/attorney-schedule-adapter.ts";
import { stepUpRefusal } from "../../account/gate.ts";

type Refusal = NonNullable<Awaited<ReturnType<typeof stepUpRefusal>>>;

async function gated<State extends { readonly status: string }>(
  operation: () => Promise<State>,
): Promise<State | Refusal> {
  const refusal = await stepUpRefusal("attorney");
  if (refusal !== null) {
    return refusal;
  }
  const state = await operation();
  if (state.status === "outcome") {
    revalidatePath("/attorney/schedule");
  }
  return state;
}

export async function addAvailabilityRule(
  _previous: ScheduleActionState,
  formData: FormData,
): Promise<ScheduleActionState> {
  return gated(() =>
    createAvailabilityRule(ATTORNEY_SCHEDULE_SOURCES, formData),
  );
}

export async function endAvailabilityRule(
  _previous: ScheduleActionState,
  formData: FormData,
): Promise<ScheduleActionState> {
  return gated(() =>
    deactivateAvailabilityRule(ATTORNEY_SCHEDULE_SOURCES, formData),
  );
}

export async function addBlackout(
  _previous: ScheduleActionState,
  formData: FormData,
): Promise<ScheduleActionState> {
  return gated(() => createBlackout(ATTORNEY_SCHEDULE_SOURCES, formData));
}

export async function deleteBlackout(
  _previous: ScheduleActionState,
  formData: FormData,
): Promise<ScheduleActionState> {
  return gated(() => removeBlackout(ATTORNEY_SCHEDULE_SOURCES, formData));
}

export async function setInstantMode(
  _previous: ScheduleActionState,
  formData: FormData,
): Promise<ScheduleActionState> {
  return gated(() => switchInstantMode(ATTORNEY_SCHEDULE_SOURCES, formData));
}

// The heartbeat: asks the server to observe this session. It reads nothing
// from the browser and changes no page.
export async function observeSession(): Promise<HeartbeatState> {
  return gated(() => observeScheduleSession(ATTORNEY_SCHEDULE_SOURCES));
}
