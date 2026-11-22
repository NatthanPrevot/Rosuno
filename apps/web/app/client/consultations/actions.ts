"use server";

// The client's Consultation server action (MVP-001 S9; MBS section 14; TA
// section 46).
//
// The join action hands the submitted form (only the Consultation id) and
// this request's trusted ports to the consultation use case, which
// re-establishes the verified client on the server, checks that media is
// configured and the environment is bound, and asks the database to authorize
// the client's media access for this one Consultation; only then does the
// server ask the media provider for one short-lived meeting token and answer
// the consultation room's address for the frame. Next.js accepts this only as
// a POST request and applies its Server Action origin checks. The previous
// state comes back from the browser and is never read. Nothing the browser
// sends chooses an identity, a role, a room or a time; the token travels only
// in this action's answer and is never stored or logged.

import { revalidatePath } from "next/cache";

import {
  openClientDocument,
  replaceClientDocument,
  revokeClientDocument,
  sendClientMessage,
  uploadClientDocument,
  type CommunicationActionState,
} from "../../../src/application/consultation-communication.ts";
import {
  cancelClientConsultation,
  type CancelActionState,
} from "../../../src/application/consultation-outcomes.ts";
import {
  joinClientConsultation,
  type JoinActionState,
} from "../../../src/application/consultations.ts";
import { CLIENT_COMMUNICATION_SOURCES } from "../../../src/infrastructure/communications/communication-adapter.ts";
import { CLIENT_OUTCOME_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { CLIENT_CONSULTATION_SOURCES } from "../../../src/infrastructure/consultations/consultation-adapter.ts";

export async function joinConsultationAction(
  _previous: JoinActionState,
  formData: FormData,
): Promise<JoinActionState> {
  return joinClientConsultation(CLIENT_CONSULTATION_SOURCES, formData);
}

// MVP-001 S10: the client's Message and document actions hand the submitted
// form (the Consultation or document id, the Message text or the file) and
// this request's trusted ports to the communication use case, which
// re-establishes the verified client on the server, checks the environment
// binding and lets the database decide: the client's own Consultation, the
// recipient (the attorney, never chosen here), whether communication is still
// open, the grant and every refusal. A file is received and checked on the
// server first (size, type from its bytes, digest); no file name is kept. A
// download link travels only in that action's answer and is never stored or
// logged. After a change the page is refreshed so the thread and the list
// show it.

function refreshed(
  formData: FormData,
  state: CommunicationActionState,
): CommunicationActionState {
  const consultation = formData.get("consultation");
  if (
    state.status === "outcome" &&
    typeof consultation === "string" &&
    /^[0-9a-f-]{36}$/.test(consultation)
  ) {
    revalidatePath(`/client/consultations/${consultation}`);
  }
  return state;
}

export async function sendMessageAction(
  _previous: CommunicationActionState,
  formData: FormData,
): Promise<CommunicationActionState> {
  return refreshed(
    formData,
    await sendClientMessage(CLIENT_COMMUNICATION_SOURCES, formData),
  );
}

export async function uploadDocumentAction(
  _previous: CommunicationActionState,
  formData: FormData,
): Promise<CommunicationActionState> {
  return refreshed(
    formData,
    await uploadClientDocument(CLIENT_COMMUNICATION_SOURCES, formData),
  );
}

export async function revokeDocumentAction(
  _previous: CommunicationActionState,
  formData: FormData,
): Promise<CommunicationActionState> {
  return refreshed(
    formData,
    await revokeClientDocument(CLIENT_COMMUNICATION_SOURCES, formData),
  );
}

// MVP-001 S10 (PS-A5): a new version of one of the client's own documents.
export async function replaceDocumentAction(
  _previous: CommunicationActionState,
  formData: FormData,
): Promise<CommunicationActionState> {
  return refreshed(
    formData,
    await replaceClientDocument(CLIENT_COMMUNICATION_SOURCES, formData),
  );
}

export async function openDocumentAction(
  _previous: CommunicationActionState,
  formData: FormData,
): Promise<CommunicationActionState> {
  return openClientDocument(CLIENT_COMMUNICATION_SOURCES, formData);
}

// MVP-001 S11: the client cancels one of their own Consultations before it
// starts. The form names only the Consultation; the use case re-establishes
// the verified client, checks the environment binding and lets the database
// decide (the client's own Consultation, its state, the Booking, the room,
// the attorney's notification and, with a live payment, one review item for
// a person; no money is moved). The page and the list are refreshed after a
// cancellation.
export async function cancelConsultationAction(
  _previous: CancelActionState,
  formData: FormData,
): Promise<CancelActionState> {
  const state = await cancelClientConsultation(
    CLIENT_OUTCOME_SOURCES,
    formData,
  );
  const consultation = formData.get("consultation");
  if (
    state.status === "outcome" &&
    typeof consultation === "string" &&
    /^[0-9a-f-]{36}$/.test(consultation)
  ) {
    revalidatePath(`/client/consultations/${consultation}`);
    revalidatePath("/client/consultations");
  }
  return state;
}
