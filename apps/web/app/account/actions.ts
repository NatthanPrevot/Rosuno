"use server";

// Authenticator setup and step-up server actions (MVP-001 S2).
//
// Each action hands the submitted form and this request's trusted ports to
// the application boundary, which re-establishes the principal and reads the
// account's factors afresh on the server, and decides a fixed outcome.
// Next.js accepts these only as POST requests and applies its Server Action
// origin checks. The previous state comes back from the browser and is never
// read. A confirmed code returns the browser to the fixed workspace the
// application boundary chose from its own allowlist; nothing the caller
// sends is ever a destination.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  confirmTotpEnrollment,
  startTotpEnrollment,
  stepUpSession,
  type CodeState,
  type EnrollmentState,
} from "../../src/application/totp-step-up.ts";
import { AUTHENTICATOR_SOURCES } from "../../src/infrastructure/identity/authenticator-provider.ts";

function settled(state: CodeState): CodeState {
  if (state.status === "verified") {
    revalidatePath(state.destination);
    redirect(state.destination);
  }
  return state;
}

export async function startEnrollment(
  _previous: EnrollmentState,
  formData: FormData,
): Promise<EnrollmentState> {
  return startTotpEnrollment(AUTHENTICATOR_SOURCES, formData);
}

export async function confirmEnrollment(
  _previous: CodeState,
  formData: FormData,
): Promise<CodeState> {
  return settled(await confirmTotpEnrollment(AUTHENTICATOR_SOURCES, formData));
}

export async function confirmStepUp(
  _previous: CodeState,
  formData: FormData,
): Promise<CodeState> {
  return settled(await stepUpSession(AUTHENTICATOR_SOURCES, formData));
}
