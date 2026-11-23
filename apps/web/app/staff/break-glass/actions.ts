"use server";

// Break-glass server actions (MVP-001 S11; PS-A6 section 2).
//
// Each action first asks the step-up gate (MVP-001 S2); a session that is not
// stepped up gets one fixed refusal and nothing is handed to the use case.
// Otherwise it hands the submitted form and this request's trusted ports to
// the use case, which re-establishes the caller's fresh staff identity (and,
// to approve or revoke, the approve_break_glass grant) before anything is
// sent; the database decides again (the Consultation exists, the approver is
// not the requester, the duration's bound, the grant's derived state) and
// audits each step with identifiers and codes only. The reason is the staff
// member's entry, stored on the grant only and never logged. Next.js accepts
// these only as POST requests and applies its Server Action origin checks.
// The previous state comes back from the browser and is never read.

import { revalidatePath } from "next/cache";

import {
  approveBreakGlass,
  requestBreakGlass,
  revokeBreakGlass,
  type GrantActionState,
} from "../../../src/application/break-glass.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { BREAK_GLASS_SOURCES } from "../../../src/infrastructure/privacy/privacy-adapter.ts";
import { stepUpRefusal } from "../../account/gate.ts";

// After each outcome the page is refreshed: a request appears in the caller's
// list, and an approved or revoked grant leaves the list it was decided from
// (the forms keep the fixed outcome in view in a slot outside that list).
async function gated(
  operation: () => Promise<GrantActionState>,
): Promise<GrantActionState> {
  const refusal = await stepUpRefusal("staff");
  if (refusal !== null) {
    return refusal;
  }
  const state = await operation();
  if (state.status === "unavailable" || state.status === "unconfirmed") {
    await logRequestEvent("warn", "break_glass.action_not_completed", {
      outcome: state.status,
    });
  }
  if (state.status === "outcome") {
    revalidatePath("/staff/break-glass");
  }
  return state;
}

export async function requestBreakGlassAction(
  _previous: GrantActionState,
  formData: FormData,
): Promise<GrantActionState> {
  return gated(() => requestBreakGlass(BREAK_GLASS_SOURCES, formData));
}

export async function approveBreakGlassAction(
  _previous: GrantActionState,
  formData: FormData,
): Promise<GrantActionState> {
  return gated(() => approveBreakGlass(BREAK_GLASS_SOURCES, formData));
}

export async function revokeBreakGlassAction(
  _previous: GrantActionState,
  formData: FormData,
): Promise<GrantActionState> {
  return gated(() => revokeBreakGlass(BREAK_GLASS_SOURCES, formData));
}
