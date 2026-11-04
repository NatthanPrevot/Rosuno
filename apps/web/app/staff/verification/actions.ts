"use server";

// Staff verification server actions (P3-003).
//
// Each action hands the submitted form and this request's trusted ports to
// the application boundary, which re-establishes the reviewer's fresh Staff
// identity and exact verification scope on the server before anything is
// written, and decides a fixed outcome. Next.js accepts these only as POST
// requests and applies its Server Action origin checks. The previous state
// comes back from the browser and is never read. After a recorded change the
// review pages are read afresh.

import { revalidatePath } from "next/cache";

import {
  changeProfileStage,
  decidePracticeArea,
  recordDisciplineFinding,
  recordEligibilityDetermination,
  recordSourceUnavailable,
  recordVerificationFinding,
  type StaffActionState,
} from "../../../src/application/staff-verification.ts";
import { STAFF_VERIFICATION_SOURCES } from "../../../src/infrastructure/staff/staff-verification-adapter.ts";

function refreshed(state: StaffActionState): StaffActionState {
  if (state.status === "recorded") {
    revalidatePath("/staff/verification");
    revalidatePath("/staff/verification/[attorney]", "page");
  }
  return state;
}

export async function recordFinding(
  _previous: StaffActionState,
  formData: FormData,
): Promise<StaffActionState> {
  return refreshed(
    await recordVerificationFinding(STAFF_VERIFICATION_SOURCES, formData),
  );
}

export async function recordUnavailableSource(
  _previous: StaffActionState,
  formData: FormData,
): Promise<StaffActionState> {
  return refreshed(
    await recordSourceUnavailable(STAFF_VERIFICATION_SOURCES, formData),
  );
}

export async function recordDiscipline(
  _previous: StaffActionState,
  formData: FormData,
): Promise<StaffActionState> {
  return refreshed(
    await recordDisciplineFinding(STAFF_VERIFICATION_SOURCES, formData),
  );
}

export async function decideArea(
  _previous: StaffActionState,
  formData: FormData,
): Promise<StaffActionState> {
  return refreshed(
    await decidePracticeArea(STAFF_VERIFICATION_SOURCES, formData),
  );
}

export async function changeStage(
  _previous: StaffActionState,
  formData: FormData,
): Promise<StaffActionState> {
  return refreshed(
    await changeProfileStage(STAFF_VERIFICATION_SOURCES, formData),
  );
}

export async function recordDetermination(
  _previous: StaffActionState,
  formData: FormData,
): Promise<StaffActionState> {
  return refreshed(
    await recordEligibilityDetermination(STAFF_VERIFICATION_SOURCES, formData),
  );
}
