"use server";

// Data request server actions (MVP-001 S11; PS-A6 section 3).
//
// Each action first asks the step-up gate (MVP-001 S2); a session that is not
// stepped up gets one fixed refusal and nothing is handed to the use case.
// Otherwise it hands the submitted form and this request's trusted ports to
// the use case, which re-establishes the caller's fresh staff identity and
// the global manage_data_requests grant before anything is sent; the
// database decides again (the request's state, the Legal Hold rule) and
// audits each step with codes and identifiers only. A decision is a record:
// nothing is executed. Next.js accepts these only as POST requests and
// applies its Server Action origin checks. The previous state comes back
// from the browser and is never read.

import { revalidatePath } from "next/cache";

import {
  assignDataRequest,
  decideDataRequest,
  type StaffActionState,
} from "../../../src/application/data-requests.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { STAFF_DATA_REQUEST_SOURCES } from "../../../src/infrastructure/privacy/privacy-adapter.ts";
import { stepUpRefusal } from "../../account/gate.ts";

async function gated(
  operation: () => Promise<StaffActionState>,
): Promise<StaffActionState> {
  const refusal = await stepUpRefusal("staff");
  if (refusal !== null) {
    return refusal;
  }
  const state = await operation();
  if (state.status === "unavailable" || state.status === "unconfirmed") {
    await logRequestEvent("warn", "data_request.action_not_completed", {
      outcome: state.status,
    });
  }
  if (state.status === "outcome") {
    revalidatePath("/staff/data-requests", "layout");
  }
  return state;
}

export async function assignDataRequestAction(
  _previous: StaffActionState,
  formData: FormData,
): Promise<StaffActionState> {
  return gated(() => assignDataRequest(STAFF_DATA_REQUEST_SOURCES, formData));
}

export async function decideDataRequestAction(
  _previous: StaffActionState,
  formData: FormData,
): Promise<StaffActionState> {
  return gated(() => decideDataRequest(STAFF_DATA_REQUEST_SOURCES, formData));
}
