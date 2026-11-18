"use server";

// Consultation Request server actions (MVP-001 S6; MBS section 11).
//
// Each action hands the submitted form and this request's trusted ports to
// the consultation request use cases, which re-establish the verified client
// on the server, check the environment binding, and ask the database to
// create or withdraw the Request; only the database's fixed outcome comes
// back. Next.js accepts these only as POST requests and applies its Server
// Action origin checks. The previous state comes back from the browser and is
// never read. Nothing the browser sends chooses an identity, a price, a
// deadline or an attorney. A created Request opens its own page; a withdrawal
// refreshes it. An unavailable or unknown outcome also writes one log line
// naming the action and the outcome, with nothing the client submitted.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  createConsultationRequest,
  requestPathFor,
  withdrawConsultationRequest,
  type RequestActionState,
  type WithdrawActionState,
} from "../../../src/application/consultation-request.ts";
import { isUuid } from "../../../src/application/professional-records.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { REQUEST_SOURCES } from "../../../src/infrastructure/requests/consultation-request-adapter.ts";

export async function createRequestAction(
  _previous: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const state = await createConsultationRequest(REQUEST_SOURCES, formData);
  if (state.status === "unavailable" || state.status === "outcome-unknown") {
    await logRequestEvent("warn", "consultation_request.action_not_completed", {
      operation: "createRequest",
      outcome: state.status,
    });
  }
  if (state.status === "created") {
    revalidatePath("/client");
    redirect(requestPathFor(state.requestId));
  }
  return state;
}

export async function withdrawRequestAction(
  _previous: WithdrawActionState,
  formData: FormData,
): Promise<WithdrawActionState> {
  const state = await withdrawConsultationRequest(REQUEST_SOURCES, formData);
  if (state.status === "unavailable" || state.status === "outcome-unknown") {
    await logRequestEvent("warn", "consultation_request.action_not_completed", {
      operation: "withdrawRequest",
      outcome: state.status,
    });
  }
  if (state.status === "withdrawn" || state.status === "expired") {
    const request = formData.get("request");
    if (isUuid(request)) {
      revalidatePath(requestPathFor(request));
    }
  }
  return state;
}
