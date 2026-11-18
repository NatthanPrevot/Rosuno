"use server";

// Attorney request decision server actions (MVP-001 S8).
//
// Each action first asks the step-up gate (MVP-001 S2); a session that is not
// stepped up gets one fixed refusal and nothing is handed to the use case.
// Otherwise it hands the submitted form and this request's trusted ports to
// the application boundary, which re-establishes the attorney principal on
// the server, checks the environment binding and calls one database function
// through the request's own session; the database decides again (the
// attorney's own offered Request, aal2, expiry, fresh evaluations and every
// consequence). Next.js accepts these only as POST requests and applies its
// Server Action origin checks. The previous state comes back from the browser
// and is never read. A submitted id only names which of the attorney's own
// Requests the decision concerns; the database checks that ownership itself.

import { revalidatePath } from "next/cache";

import {
  acceptAttorneyRequest,
  declineAttorneyRequest,
  type DecisionActionState,
} from "../../../src/application/attorney-requests.ts";
import { ATTORNEY_REQUEST_SOURCES } from "../../../src/infrastructure/requests/attorney-request-adapter.ts";
import { stepUpRefusal } from "../../account/gate.ts";

async function gated(
  operation: () => Promise<DecisionActionState>,
): Promise<DecisionActionState> {
  const refusal = await stepUpRefusal("attorney");
  if (refusal !== null) {
    return refusal;
  }
  const state = await operation();
  // The queue is refreshed; the request page keeps its forms, so the fixed
  // outcome message stays in view until the attorney reloads the page.
  if (state.status === "outcome") {
    revalidatePath("/attorney/requests");
  }
  return state;
}

export async function acceptRequestAction(
  _previous: DecisionActionState,
  formData: FormData,
): Promise<DecisionActionState> {
  return gated(() => acceptAttorneyRequest(ATTORNEY_REQUEST_SOURCES, formData));
}

export async function declineRequestAction(
  _previous: DecisionActionState,
  formData: FormData,
): Promise<DecisionActionState> {
  return gated(() =>
    declineAttorneyRequest(ATTORNEY_REQUEST_SOURCES, formData),
  );
}
