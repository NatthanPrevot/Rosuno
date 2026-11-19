"use server";

// The client's notification center action (MVP-001 S10; MBS section 15
// deliverable 12C).
//
// The acknowledge action hands the submitted form (only the Notification id)
// and this request's trusted ports to the notification center use case, which
// re-establishes the verified client on the server and asks the database to
// acknowledge one of the client's own in-app Notifications that requires it
// (the database decides again and audits it). Next.js accepts this only as a
// POST request and applies its Server Action origin checks. The previous
// state comes back from the browser and is never read.

import { revalidatePath } from "next/cache";

import {
  acknowledgeClientNotification,
  type AcknowledgeActionState,
} from "../../../src/application/notification-center.ts";
import { CLIENT_CENTER_SOURCES } from "../../../src/infrastructure/communications/communication-adapter.ts";

export async function acknowledgeNotificationAction(
  _previous: AcknowledgeActionState,
  formData: FormData,
): Promise<AcknowledgeActionState> {
  const state = await acknowledgeClientNotification(
    CLIENT_CENTER_SOURCES,
    formData,
  );
  if (state.status === "outcome" && state.outcome === "acknowledged") {
    revalidatePath("/client/notifications");
  }
  return state;
}
