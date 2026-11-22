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
  replaceAttorneyDocument,
  revokeAttorneyDocument,
  sendAttorneyMessage,
  uploadAttorneyDocument,
  type CommunicationActionState,
} from "../../../src/application/consultation-communication.ts";
import {
  cancelAttorneyConsultation,
  endConsultationEarly,
  type CancelActionState,
  type EndEarlyActionState,
} from "../../../src/application/consultation-outcomes.ts";
import {
  endConsultation,
  joinAttorneyConsultation,
  startConsultation,
  type CommandActionState,
  type JoinActionState,
} from "../../../src/application/consultations.ts";
import { ATTORNEY_COMMUNICATION_SOURCES } from "../../../src/infrastructure/communications/communication-adapter.ts";
import { ATTORNEY_OUTCOME_SOURCES } from "../../../src/infrastructure/consultations/completion-adapter.ts";
import { ATTORNEY_CONSULTATION_SOURCES } from "../../../src/infrastructure/consultations/consultation-adapter.ts";
import { stepUpRefusal } from "../../account/gate.ts";

async function gated<
  State extends
    | JoinActionState
    | CommandActionState
    | CommunicationActionState
    | CancelActionState
    | EndEarlyActionState,
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

// MVP-001 S10 (PS-A5): a new version of one of the attorney's own documents.
export async function replaceDocumentAction(
  _previous: CommunicationActionState,
  formData: FormData,
): Promise<CommunicationActionState> {
  return gated(() =>
    replaceAttorneyDocument(ATTORNEY_COMMUNICATION_SOURCES, formData).then(
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

// MVP-001 S11: the attorney cancels one of their own Consultations before it
// starts, or records that a live one ended early by agreement (before its
// nominal end). Both go through the same guarded helper; the database decides
// again (the attorney's own Consultation at aal2, the state, the nominal end,
// the Booking, the room, the client's notification and every payment
// consequence: a cancellation moves no money and opens one review item for a
// person when a payment is live; an early end follows the normal end's
// payment rule and refunds nothing). The Consultation page is refreshed.

export async function cancelConsultationAction(
  _previous: CancelActionState,
  formData: FormData,
): Promise<CancelActionState> {
  return gated(() =>
    cancelAttorneyConsultation(ATTORNEY_OUTCOME_SOURCES, formData).then(
      (state) => refreshedOutcome(formData, state),
    ),
  );
}

export async function endEarlyAction(
  _previous: EndEarlyActionState,
  formData: FormData,
): Promise<EndEarlyActionState> {
  return gated(() =>
    endConsultationEarly(ATTORNEY_OUTCOME_SOURCES, formData).then((state) =>
      refreshedOutcome(formData, state),
    ),
  );
}

function refreshedOutcome<
  State extends CancelActionState | EndEarlyActionState,
>(formData: FormData, state: State): State {
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
