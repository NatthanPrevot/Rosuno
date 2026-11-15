"use server";

// Client intake server actions (P5-001).
//
// Each action hands the submitted form and this request's trusted ports to
// the application boundary, which re-establishes the client's identity and
// own Client Profile on the server and decides a fixed outcome. Next.js
// accepts these only as POST requests and applies its Server Action origin
// checks. The previous state comes back from the browser and is never read.
// Nothing the browser sends chooses an identity, User, profile, state, or
// authority. After a change the pages are read afresh.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  closeIntake,
  saveIntakeRevision,
  startIntake,
  submitIntake,
  type ClientIntakeActionState,
} from "../../src/application/client-intake.ts";
import { isUuid } from "../../src/application/professional-records.ts";
import { CLIENT_INTAKE_SOURCES } from "../../src/infrastructure/client/client-intake-adapter.ts";

const CHANGED = new Set<ClientIntakeActionState["status"]>([
  "saved",
  "submitted",
  "closed",
]);

function refreshed(
  formData: FormData,
  state: ClientIntakeActionState,
): ClientIntakeActionState {
  if (CHANGED.has(state.status)) {
    revalidatePath("/client");
    const intake = formData.get("intake");
    if (isUuid(intake)) {
      revalidatePath(`/client/intakes/${intake}`);
    }
  }
  return state;
}

export async function startIntakeAction(
  _previous: ClientIntakeActionState,
  _formData: FormData,
): Promise<ClientIntakeActionState> {
  const state = await startIntake(CLIENT_INTAKE_SOURCES);
  if (state.status === "created") {
    revalidatePath("/client");
    redirect(`/client/intakes/${state.intakeId}`);
  }
  return state;
}

export async function saveIntakeAction(
  _previous: ClientIntakeActionState,
  formData: FormData,
): Promise<ClientIntakeActionState> {
  return refreshed(
    formData,
    await saveIntakeRevision(CLIENT_INTAKE_SOURCES, formData),
  );
}

export async function submitIntakeAction(
  _previous: ClientIntakeActionState,
  formData: FormData,
): Promise<ClientIntakeActionState> {
  return refreshed(
    formData,
    await submitIntake(CLIENT_INTAKE_SOURCES, formData),
  );
}

export async function closeIntakeAction(
  _previous: ClientIntakeActionState,
  formData: FormData,
): Promise<ClientIntakeActionState> {
  return refreshed(
    formData,
    await closeIntake(CLIENT_INTAKE_SOURCES, formData),
  );
}
