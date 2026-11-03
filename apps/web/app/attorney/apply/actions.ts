"use server";

// Attorney application start server action (P3-002).
//
// Hands the submitted form and this request's trusted ports to the
// application boundary, which reads nothing before the form is an explicit
// start request and decides the fixed outcome. Next.js accepts this only as a
// POST request and applies its Server Action origin checks. Nothing the
// caller sends chooses an identity, User, profile, state, role, or
// destination. A definite outcome returns to the fixed entry page, which
// reads the account's standing afresh, so success is never taken from this
// action's own answer. A failed or unconfirmed start is never reported as
// success: it is shown only as the generic error boundary.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { startAttorneyApplication } from "../../../src/application/attorney-application.ts";
import {
  ATTORNEY_APPLICANT_PROVISIONING,
  ATTORNEY_APPLICATION_ACCOUNT,
} from "../../../src/infrastructure/identity/attorney-application-provisioning.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../../src/infrastructure/identity/server-session-source.ts";

export async function startApplication(formData: FormData): Promise<void> {
  const outcome = await startAttorneyApplication(
    {
      session: SUPABASE_SERVER_SESSION_SOURCE,
      account: ATTORNEY_APPLICATION_ACCOUNT,
      provisioning: ATTORNEY_APPLICANT_PROVISIONING,
    },
    formData,
  );
  if (outcome.status === "unavailable" || outcome.status === "unconfirmed") {
    throw new Error("The attorney application could not be completed.");
  }
  revalidatePath("/attorney");
  revalidatePath("/attorney/apply");
  redirect("/attorney/apply");
}
