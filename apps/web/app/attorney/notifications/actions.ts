"use server";

// The attorney's notification center action (MVP-001 S10; MBS section 15
// deliverable 12C).
//
// The action first asks the step-up gate (MVP-001 S2); a session that is not
// stepped up gets one fixed refusal and nothing is handed to the use case.
// Otherwise it hands the submitted form (only the Notification id) and this
// request's trusted ports to the notification center use case, which
// re-establishes the attorney principal on the server and asks the database
// to acknowledge one of the attorney's own in-app Notifications that requires
// it (aal2; the database decides again and audits it). Next.js accepts this
// only as a POST request and applies its Server Action origin checks.

import { revalidatePath } from "next/cache";

import {
  acknowledgeAttorneyNotification,
  type AcknowledgeActionState,
} from "../../../src/application/notification-center.ts";
import { ATTORNEY_CENTER_SOURCES } from "../../../src/infrastructure/communications/communication-adapter.ts";
import { stepUpRefusal } from "../../account/gate.ts";

async function gated(
  operation: () => Promise<AcknowledgeActionState>,
): Promise<AcknowledgeActionState> {
  const refusal = await stepUpRefusal("attorney");
  if (refusal !== null) {
    return refusal;
  }
  const state = await operation();
  if (state.status === "outcome" && state.outcome === "acknowledged") {
    revalidatePath("/attorney/notifications");
  }
  return state;
}

export async function acknowledgeNotificationAction(
  _previous: AcknowledgeActionState,
  formData: FormData,
): Promise<AcknowledgeActionState> {
  return gated(() =>
    acknowledgeAttorneyNotification(ATTORNEY_CENTER_SOURCES, formData),
  );
}
