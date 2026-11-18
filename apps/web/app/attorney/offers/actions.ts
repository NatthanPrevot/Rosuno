"use server";

// Attorney consultation offer server actions (MVP-001 S6; PS-A3 section 4).
//
// Each action first asks the step-up gate (MVP-001 S2); a session that is not
// stepped up gets one fixed refusal and nothing is handed to the use case.
// Otherwise it hands the submitted form and this request's trusted ports to
// the application boundary, which re-establishes the attorney principal on
// the server, checks the environment binding and calls one database function
// through the request's own session; the database decides again. Next.js
// accepts these only as POST requests and applies its Server Action origin
// checks. The previous state comes back from the browser and is never read.
// Nothing the caller sends chooses an identity or a profile: a submitted id
// only names which of the attorney's own offers a withdrawal concerns, and
// the type, length, currency and price are the attorney's own entries, which
// the database checks against the platform's options.

import { revalidatePath } from "next/cache";

import {
  setConsultationOffer,
  withdrawConsultationOffer,
  type OfferActionState,
} from "../../../src/application/consultation-offers.ts";
import { OFFER_SOURCES } from "../../../src/infrastructure/offers/consultation-offer-adapter.ts";
import { stepUpRefusal } from "../../account/gate.ts";

type Refusal = NonNullable<Awaited<ReturnType<typeof stepUpRefusal>>>;

async function gated<State extends { readonly status: string }>(
  operation: () => Promise<State>,
): Promise<State | Refusal> {
  const refusal = await stepUpRefusal("attorney");
  if (refusal !== null) {
    return refusal;
  }
  const state = await operation();
  if (state.status === "outcome") {
    revalidatePath("/attorney/offers");
  }
  return state;
}

export async function setOfferAction(
  _previous: OfferActionState,
  formData: FormData,
): Promise<OfferActionState> {
  return gated(() => setConsultationOffer(OFFER_SOURCES, formData));
}

export async function withdrawOfferAction(
  _previous: OfferActionState,
  formData: FormData,
): Promise<OfferActionState> {
  return gated(() => withdrawConsultationOffer(OFFER_SOURCES, formData));
}
