"use server";

// Attorney professional setup server actions (P3-003).
//
// Each action hands the submitted form and this request's trusted ports to
// the application boundary, which re-establishes the attorney's identity and
// own profile on the server and decides a fixed outcome. Next.js accepts
// these only as POST requests and applies its Server Action origin checks.
// The previous state comes back from the browser and is never read. Nothing
// the caller sends chooses an identity, User, profile, stage, verification
// status, or decision. After a saved change the page is read afresh.
// MVP-001 S2: each action first asks the step-up gate; a session that is not
// stepped up gets one fixed refusal, and nothing is handed to the use case.

import { revalidatePath } from "next/cache";

import {
  changePracticeAreaRequest,
  requestPracticeArea,
  saveInsuranceClaim,
  saveLicenseClaim,
  saveProfileDetails,
  submitApplicationForReview,
  type ProfessionalActionState,
} from "../../../src/application/attorney-professional.ts";
import { ATTORNEY_PROFESSIONAL_SOURCES } from "../../../src/infrastructure/professional/attorney-professional-adapter.ts";
import { stepUpRefusal } from "../../account/gate.ts";

async function gated(
  operation: () => Promise<ProfessionalActionState>,
): Promise<ProfessionalActionState> {
  const refusal = await stepUpRefusal("attorney");
  if (refusal !== null) {
    return refusal;
  }
  const state = await operation();
  if (state.status === "saved") {
    revalidatePath("/attorney/professional");
    revalidatePath("/attorney");
  }
  return state;
}

export async function saveDetails(
  _previous: ProfessionalActionState,
  formData: FormData,
): Promise<ProfessionalActionState> {
  return gated(() =>
    saveProfileDetails(ATTORNEY_PROFESSIONAL_SOURCES, formData),
  );
}

export async function saveLicense(
  _previous: ProfessionalActionState,
  formData: FormData,
): Promise<ProfessionalActionState> {
  return gated(() => saveLicenseClaim(ATTORNEY_PROFESSIONAL_SOURCES, formData));
}

export async function saveInsurance(
  _previous: ProfessionalActionState,
  formData: FormData,
): Promise<ProfessionalActionState> {
  return gated(() =>
    saveInsuranceClaim(ATTORNEY_PROFESSIONAL_SOURCES, formData),
  );
}

export async function requestArea(
  _previous: ProfessionalActionState,
  formData: FormData,
): Promise<ProfessionalActionState> {
  return gated(() =>
    requestPracticeArea(ATTORNEY_PROFESSIONAL_SOURCES, formData),
  );
}

export async function changeAreaRequest(
  _previous: ProfessionalActionState,
  formData: FormData,
): Promise<ProfessionalActionState> {
  return gated(() =>
    changePracticeAreaRequest(ATTORNEY_PROFESSIONAL_SOURCES, formData),
  );
}

export async function submitForReview(
  _previous: ProfessionalActionState,
  formData: FormData,
): Promise<ProfessionalActionState> {
  return gated(() =>
    submitApplicationForReview(ATTORNEY_PROFESSIONAL_SOURCES, formData),
  );
}
