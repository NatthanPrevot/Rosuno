"use server";

// The attorney's Consultation server actions (MVP-001 S9; MBS section 14; TA
// sections 46 and 48; PM row 20).
//
// Each action first asks the step-up gate (MVP-001 S2); a session that is not
// stepped up gets one fixed refusal and nothing is handed to the use case.
// Otherwise it hands the submitted form and this request's trusted ports to
// the application boundary, which re-establishes the attorney principal on
// the server, checks the environment binding and calls one database function
// through the request's own session; the database decides again (the
// attorney's own Consultation, aal2, the window, every precondition and every
// consequence). Joining also needs media to be configured; the meeting token
// travels only in that action's answer and is never stored or logged.
// Next.js accepts these only as POST requests and applies its Server Action
// origin checks. The previous state comes back from the browser and is never
// read. A submitted id only names which of the attorney's own Consultations
// the action concerns; the database checks that ownership itself.

import { revalidatePath } from "next/cache";

import {
  openAttorneyDocument,
  revokeAttorneyDocument,
  sendAttorneyMessage,
  uploadAttorneyDocument,
  type CommunicationActionState,
} from "../../../src/application/consultation-communication.ts";
import {
  endConsultation,
  joinAttorneyConsultation,
  startConsultation,
  type CommandActionState,
  type JoinActionState,
} from "../../../src/application/consultations.ts";
import { ATTORNEY_COMMUNICATION_SOURCES } from "../../../src/infrastructure/communications/communication-adapter.ts";
import { ATTORNEY_CONSULTATION_SOURCES } from "../../../src/infrastructure/consultations/consultation-adapter.ts";
import { stepUpRefusal } from "../../account/gate.ts";

async function gated<
  State extends JoinActionState | CommandActionState | CommunicationActionState,
>(
  operation: () => Promise<State>,
): Promise<State | Exclude<Awaited<ReturnType<typeof stepUpRefusal>>, null>> {
  const refusal = await stepUpRefusal("attorney");
  if (refusal !== null) {
    return refusal;
  }
  const state = await operation();
  // The list is refreshed; the consultation page keeps its forms, so the
  // fixed outcome message stays in view until the attorney reloads the page.
  if (state.status === "outcome") {
    revalidatePath("/attorney/consultations");
  }
  return state;
}

export async function joinConsultationAction(
  _previous: JoinActionState,
  formData: FormData,
): Promise<JoinActionState> {
  return gated(() =>
    joinAttorneyConsultation(ATTORNEY_CONSULTATION_SOURCES, formData),
  );
}

export async function startConsultationAction(
  _previous: CommandActionState,
  formData: FormData,
): Promise<CommandActionState> {
  return gated(() =>
    startConsultation(ATTORNEY_CONSULTATION_SOURCES, formData),
  );
}

export async function endConsultationAction(
  _previous: CommandActionState,
  formData: FormData,
): Promise<CommandActionState> {
  return gated(() => endConsultation(ATTORNEY_CONSULTATION_SOURCES, formData));
}

// MVP-001 S10: the attorney's Message and document actions go through the
// same guarded helper (the step-up gate first; a session that is not stepped
// up gets one fixed refusal and nothing is handed to the use case), then hand
// the submitted form and this request's trusted ports to the communication
// use case; the database decides again (the attorney's own Consultation at
// aal2, the recipient, whether communication is still open, the grant and
// every refusal). A download link travels only in that action's answer and is
// never stored or logged. After a change the Consultation page is refreshed.

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
    revalidatePath(`/attorney/consultations/${consultation}`);
  }
  return state;
}

export async function sendMessageAction(
  _previous: CommunicationActionState,
  formData: FormData,
): Promise<CommunicationActionState> {
  return gated(() =>
    sendAttorneyMessage(ATTORNEY_COMMUNICATION_SOURCES, formData).then(
      (state) => refreshed(formData, state),
    ),
  );
}

export async function uploadDocumentAction(
  _previous: CommunicationActionState,
  formData: FormData,
): Promise<CommunicationActionState> {
  return gated(() =>
    uploadAttorneyDocument(ATTORNEY_COMMUNICATION_SOURCES, formData).then(
      (state) => refreshed(formData, state),
    ),
  );
}

export async function revokeDocumentAction(
  _previous: CommunicationActionState,
  formData: FormData,
): Promise<CommunicationActionState> {
  return gated(() =>
    revokeAttorneyDocument(ATTORNEY_COMMUNICATION_SOURCES, formData).then(
      (state) => refreshed(formData, state),
    ),
  );
}

export async function openDocumentAction(
  _previous: CommunicationActionState,
  formData: FormData,
): Promise<CommunicationActionState> {
  return gated(() =>
    openAttorneyDocument(ATTORNEY_COMMUNICATION_SOURCES, formData),
  );
}
