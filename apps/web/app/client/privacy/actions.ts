"use server";

// The client's data request actions (MVP-001 S11; PS-A6 section 3).
//
// Each action hands the submitted form (the request type and the optional
// description, or the request to withdraw) and this request's trusted ports
// to the data request use case, which re-establishes the verified client on
// the server, checks the environment binding and lets the database decide:
// the client is the requester, one open request per type, a request is
// withdrawn only before its decision. The description is the client's own
// entry and is never logged. Next.js accepts these only as POST requests and
// applies its Server Action origin checks. The previous state comes back
// from the browser and is never read.

import { revalidatePath } from "next/cache";

import {
  submitDataRequest,
  withdrawDataRequest,
  type ClientActionState,
} from "../../../src/application/data-requests.ts";
import { logRequestEvent } from "../../../src/infrastructure/observability/request-log.ts";
import { CLIENT_DATA_REQUEST_SOURCES } from "../../../src/infrastructure/privacy/privacy-adapter.ts";

// After a submission the page is refreshed (the list shows the request);
// after a withdrawal, which removes the request's form, the fixed outcome
// stays in view until the next load.
async function settled(
  operation: string,
  run: () => Promise<ClientActionState>,
  refresh = true,
): Promise<ClientActionState> {
  const state = await run();
  if (state.status === "unavailable" || state.status === "unconfirmed") {
    await logRequestEvent("warn", "data_request.action_not_completed", {
      operation,
      outcome: state.status,
    });
  }
  if (state.status === "outcome" && refresh) {
    revalidatePath("/client/privacy");
  }
  return state;
}

export async function submitDataRequestAction(
  _previous: ClientActionState,
  formData: FormData,
): Promise<ClientActionState> {
  return settled("submitDataRequest", () =>
    submitDataRequest(CLIENT_DATA_REQUEST_SOURCES, formData),
  );
}

export async function withdrawDataRequestAction(
  _previous: ClientActionState,
  formData: FormData,
): Promise<ClientActionState> {
  return settled(
    "withdrawDataRequest",
    () => withdrawDataRequest(CLIENT_DATA_REQUEST_SOURCES, formData),
    false,
  );
}
