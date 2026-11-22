"use server";

// The attorney's report action (MVP-001 S11; MBS section 16 "Complaint
// foundation"; PM row 47).
//
// The action first asks the step-up gate (MVP-001 S2); a session that is not
// stepped up gets one fixed refusal and nothing is handed to the use case.
// Otherwise it hands the submitted form (at most the Consultation the report
// is about) and this request's trusted ports to the complaint use case, which
// re-establishes the attorney principal on the server, checks the environment
// binding and lets the database decide: the attorney is the complainant, the
// Consultation must be one of their own, the jurisdiction is derived and
// nothing else changes. Next.js accepts this only as a POST request and
// applies its Server Action origin checks. The previous state comes back from
// the browser and is never read.

import { revalidatePath } from "next/cache";

import {
  openAttorneyComplaint,
  type OpenActionState,
} from "../../../src/application/complaints.ts";
import { ATTORNEY_COMPLAINT_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { stepUpRefusal } from "../../account/gate.ts";

async function gated(
  operation: () => Promise<OpenActionState>,
): Promise<OpenActionState> {
  const refusal = await stepUpRefusal("attorney");
  if (refusal !== null) {
    return refusal;
  }
  const state = await operation();
  if (state.status === "unavailable" || state.status === "unconfirmed") {
    await logRequestEvent("warn", "complaint.action_not_completed", {
      outcome: state.status,
    });
  }
  if (state.status === "outcome") {
    revalidatePath("/attorney/complaints");
  }
  return state;
}

export async function openComplaintAction(
  _previous: OpenActionState,
  formData: FormData,
): Promise<OpenActionState> {
  return gated(() =>
    openAttorneyComplaint(ATTORNEY_COMPLAINT_SOURCES, formData),
  );
}
