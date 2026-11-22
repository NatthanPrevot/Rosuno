"use server";

// Legal Hold server actions (MVP-001 S11; PS section 26.2; TA sections 40 and
// 51; PM row 48).
//
// Each action first asks the step-up gate (MVP-001 S2); a session that is not
// stepped up gets one fixed refusal and nothing is handed to the use case.
// Otherwise it hands the submitted form and this request's trusted ports to
// the use case, which re-establishes the caller's fresh staff identity and the
// global manage_legal_holds grant before anything is sent; the database
// decides again (the scope exists, the hold is released once) and audits each
// step with identifiers only. The reason is the staff member's entry, stored
// on the hold only and never logged. Next.js accepts these only as POST
// requests and applies its Server Action origin checks. The previous state
// comes back from the browser and is never read.

import { revalidatePath } from "next/cache";

import {
  placeLegalHold,
  releaseLegalHold,
  type HoldActionState,
} from "../../../src/application/legal-holds.ts";
import { LEGAL_HOLD_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { stepUpRefusal } from "../../account/gate.ts";

// After a change the page is refreshed, except after a change that removes
// the item from its own list (a resolution, a moderation decision, a
// release): there the fixed outcome stays in view until the next load.
async function gated(
  operation: () => Promise<HoldActionState>,
  refresh = true,
): Promise<HoldActionState> {
  const refusal = await stepUpRefusal("staff");
  if (refusal !== null) {
    return refusal;
  }
  const state = await operation();
  if (state.status === "unavailable" || state.status === "unconfirmed") {
    await logRequestEvent("warn", "legal_hold.action_not_completed", {
      outcome: state.status,
    });
  }
  if (state.status === "outcome" && refresh) {
    revalidatePath("/staff/legal-holds");
    revalidatePath("/staff/complaints", "layout");
  }
  return state;
}

export async function placeHoldAction(
  _previous: HoldActionState,
  formData: FormData,
): Promise<HoldActionState> {
  return gated(() => placeLegalHold(LEGAL_HOLD_SOURCES, formData));
}

export async function releaseHoldAction(
  _previous: HoldActionState,
  formData: FormData,
): Promise<HoldActionState> {
  return gated(() => releaseLegalHold(LEGAL_HOLD_SOURCES, formData), false);
}
