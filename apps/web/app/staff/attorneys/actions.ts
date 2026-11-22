"use server";

// Attorney lifecycle server actions (MVP-001 S11 pass 2; DM section 5; TA
// section 18 "attorney operations incl. suspensions/removals"; MB section
// 19).
//
// The action first asks the step-up gate (MVP-001 S2); a session that is not
// stepped up gets one fixed refusal and nothing is handed to the use case.
// Otherwise it hands the submitted form and this request's trusted ports to
// the use case, which re-establishes the caller's fresh staff identity and
// the global manage_attorney_verification grant before anything is sent; the
// database decides the transition, the self-action rule and the open rejoin
// review again and audits the change. Next.js accepts this only as a POST
// request and applies its Server Action origin checks. The previous state
// comes back from the browser and is never read. An outcome that is
// unavailable or unconfirmed also writes one log line naming the action and
// the outcome, with nothing the caller submitted.

import { revalidatePath } from "next/cache";

import {
  changeAttorneyLifecycle,
  type LifecycleActionState,
} from "../../../src/application/administration-workspace.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { ADMINISTRATION_SOURCES } from "../../../src/infrastructure/staff/operations-adapter.ts";
import { stepUpRefusal } from "../../account/gate.ts";

async function gated(
  operation: () => Promise<LifecycleActionState>,
): Promise<LifecycleActionState> {
  const refusal = await stepUpRefusal("staff");
  if (refusal !== null) {
    return refusal;
  }
  const state = await operation();
  if (state.status === "unavailable" || state.status === "unconfirmed") {
    await logRequestEvent("warn", "attorney_lifecycle.action_not_completed", {
      outcome: state.status,
    });
  }
  if (state.status === "outcome") {
    revalidatePath("/staff/attorneys", "layout");
    revalidatePath("/staff/compliance");
  }
  return state;
}

export async function changeAttorneyLifecycleAction(
  _previous: LifecycleActionState,
  formData: FormData,
): Promise<LifecycleActionState> {
  return gated(() => changeAttorneyLifecycle(ADMINISTRATION_SOURCES, formData));
}
