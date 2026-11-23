"use server";

// Complaint workspace server actions (MVP-001 S11; MBS section 16 "Complaint
// foundation"; PS sections 27.1 and 30.4; TA section 40).
//
// Each action first asks the step-up gate (MVP-001 S2); a session that is not
// stepped up gets one fixed refusal and nothing is handed to the use case.
// Otherwise it hands the submitted form and this request's trusted ports to
// the use case, which re-establishes the caller's fresh staff identity and
// manage_complaints before anything is sent; the database decides again (the
// capability for the case's jurisdiction, every transition, and the
// complaint vocabularies, which are configuration: while none is selectable,
// classification and resolution answer configuration_unavailable and change
// nothing) and audits every step. Next.js accepts these only as POST requests
// and applies its Server Action origin checks. The previous state comes back
// from the browser and is never read.

import { revalidatePath } from "next/cache";

import {
  classifyComplaintCase,
  resolveComplaintCaseCommand,
  updateComplaintCase,
  type CaseActionState,
} from "../../../src/application/complaints.ts";
import { STAFF_COMPLAINT_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { stepUpRefusal } from "../../account/gate.ts";

async function gated(
  operation: () => Promise<CaseActionState>,
): Promise<CaseActionState> {
  const refusal = await stepUpRefusal("staff");
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
    revalidatePath("/staff/complaints", "layout");
  }
  return state;
}

export async function updateCaseAction(
  _previous: CaseActionState,
  formData: FormData,
): Promise<CaseActionState> {
  return gated(() => updateComplaintCase(STAFF_COMPLAINT_SOURCES, formData));
}

export async function classifyCaseAction(
  _previous: CaseActionState,
  formData: FormData,
): Promise<CaseActionState> {
  return gated(() => classifyComplaintCase(STAFF_COMPLAINT_SOURCES, formData));
}

export async function resolveCaseAction(
  _previous: CaseActionState,
  formData: FormData,
): Promise<CaseActionState> {
  return gated(() =>
    resolveComplaintCaseCommand(STAFF_COMPLAINT_SOURCES, formData),
  );
}
