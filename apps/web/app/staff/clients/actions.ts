"use server";

// Client administration server actions (MVP-001 S11 pass 2; MBS section
// 18.4 "clients"; TA section 18; DM section 3; PM row 46).
//
// The action first asks the step-up gate (MVP-001 S2); a session that is not
// stepped up gets one fixed refusal and nothing is handed to the use case.
// Otherwise it hands the submitted form and this request's trusted ports to
// the use case, which re-establishes the caller's fresh staff identity and
// the global manage_client_accounts grant before anything is sent; the
// database decides the transition, the self-action rule and the PM row 46
// review item again and audits the change. Next.js accepts this only as a
// POST request and applies its Server Action origin checks. The previous
// state comes back from the browser and is never read. An outcome that is
// unavailable or unconfirmed also writes one log line naming the action and
// the outcome, with nothing the caller submitted.

import { revalidatePath } from "next/cache";

import {
  changeClientAccount,
  type ClientActionState,
} from "../../../src/application/administration-workspace.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { ADMINISTRATION_SOURCES } from "../../../src/infrastructure/staff/operations-adapter.ts";
import { stepUpRefusal } from "../../account/gate.ts";

async function gated(
  operation: () => Promise<ClientActionState>,
): Promise<ClientActionState> {
  const refusal = await stepUpRefusal("staff");
  if (refusal !== null) {
    return refusal;
  }
  const state = await operation();
  if (state.status === "unavailable" || state.status === "unconfirmed") {
    await logRequestEvent("warn", "client_account.action_not_completed", {
      outcome: state.status,
    });
  }
  if (state.status === "outcome") {
    revalidatePath("/staff/clients", "layout");
  }
  return state;
}

export async function changeClientAccountAction(
  _previous: ClientActionState,
  formData: FormData,
): Promise<ClientActionState> {
  return gated(() => changeClientAccount(ADMINISTRATION_SOURCES, formData));
}
