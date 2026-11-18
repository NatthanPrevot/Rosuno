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

import {
  joinClientConsultation,
  type JoinActionState,
} from "../../../src/application/consultations.ts";
import { CLIENT_CONSULTATION_SOURCES } from "../../../src/infrastructure/consultations/consultation-adapter.ts";

export async function joinConsultationAction(
  _previous: JoinActionState,
  formData: FormData,
): Promise<JoinActionState> {
  return joinClientConsultation(CLIENT_CONSULTATION_SOURCES, formData);
}
