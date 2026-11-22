"use server";

// The client's report action (MVP-001 S11; MBS section 16 "Complaint
// foundation"; PM row 47).
//
// The action hands the submitted form (at most the Consultation the report is
// about) and this request's trusted ports to the complaint use case, which
// re-establishes the verified client on the server, checks the environment
// binding and lets the database decide: the client is the complainant, the
// Consultation must be one of their own, the jurisdiction is derived and
// nothing else changes. Next.js accepts this only as a POST request and
// applies its Server Action origin checks. The previous state comes back from
// the browser and is never read.

import { revalidatePath } from "next/cache";

import {
  openClientComplaint,
  type OpenActionState,
} from "../../../src/application/complaints.ts";
import { CLIENT_COMPLAINT_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";

export async function openComplaintAction(
  _previous: OpenActionState,
  formData: FormData,
): Promise<OpenActionState> {
  const state = await openClientComplaint(CLIENT_COMPLAINT_SOURCES, formData);
  if (state.status === "unavailable" || state.status === "unconfirmed") {
    await logRequestEvent("warn", "complaint.action_not_completed", {
      operation: "openComplaint",
      outcome: state.status,
    });
  }
  if (state.status === "outcome") {
    revalidatePath("/client/complaints");
  }
  return state;
}
