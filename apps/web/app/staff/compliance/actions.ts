"use server";

// Compliance review item server actions (MVP-001 S11; PS section 30.4; PM
// rows 37 to 45).
//
// Each action first asks the step-up gate (MVP-001 S2); a session that is not
// stepped up gets one fixed refusal and nothing is handed to the use case.
// Otherwise it hands the submitted form and this request's trusted ports to
// the use case, which re-establishes the caller's fresh staff identity and
// the global manage_compliance_reviews grant before anything is sent; the
// database decides again by the item's own family and audits every change.
// Next.js accepts these only as POST requests and applies its Server Action
// origin checks. The previous state comes back from the browser and is never
// read. An outcome that is unavailable or unconfirmed also writes one log
// line naming the action and the outcome, with nothing the caller submitted.

import { revalidatePath } from "next/cache";

import {
  assignFamilyException,
  resolveFamilyException,
  type ReviewItemActionState,
} from "../../../src/application/consultation-outcomes.ts";
import { OPERATIONS_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { stepUpRefusal } from "../../account/gate.ts";

// After a change the page is refreshed, except after a change that removes
// the item from its own list (a resolution, a moderation decision, a
// release): there the fixed outcome stays in view until the next load.
async function gated(
  operation: () => Promise<ReviewItemActionState>,
  refresh = true,
) {
  const refusal = await stepUpRefusal("staff");
  if (refusal !== null) {
    return refusal;
  }
  const state = await operation();
  if (state.status === "unavailable" || state.status === "unconfirmed") {
    await logRequestEvent("warn", "compliance.action_not_completed", {
      outcome: state.status,
    });
  }
  if (state.status === "outcome" && refresh) {
    revalidatePath("/staff/compliance");
  }
  return state;
}

export async function assignComplianceItemAction(
  _previous: ReviewItemActionState,
  formData: FormData,
): Promise<ReviewItemActionState> {
  return gated(() =>
    assignFamilyException(OPERATIONS_SOURCES, "compliance", formData),
  );
}

// The resolution of one review item of the family (it leaves the open list).
const resolveItem = (formData: FormData) =>
  resolveFamilyException(OPERATIONS_SOURCES, "compliance", formData);

export async function resolveComplianceItemAction(
  _previous: ReviewItemActionState,
  formData: FormData,
): Promise<ReviewItemActionState> {
  return gated(() => resolveItem(formData), false);
}
