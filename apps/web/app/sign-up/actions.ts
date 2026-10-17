"use server";

// Client registration server action (P2-006).
//
// Builds the request's registration ports and hands the submitted form to
// the application boundary, which validates every field before any provider
// call and decides the fixed result. Next.js accepts this only as a POST
// request and applies its Server Action origin checks. Registration stays
// refused before any account creation until a separately authorized gate
// wires verified abuse-control enforcement here: the default-deny control
// below never allows an attempt. Nothing the caller sends chooses an
// identity, role, profile, or destination.

import {
  NO_TRUSTED_ABUSE_CONTROL,
  registerClientAccount,
  type RegistrationState,
} from "../../src/application/client-registration.ts";
import {
  createConfirmationDispatch,
  createRegistrationProvisioning,
} from "../../src/infrastructure/identity/registration-provisioning.ts";

// The previous state comes back from the browser and is never read.
export async function register(
  _previous: RegistrationState,
  formData: FormData,
): Promise<RegistrationState> {
  return registerClientAccount(
    {
      abuseControl: NO_TRUSTED_ABUSE_CONTROL,
      provisioning: () => createRegistrationProvisioning(),
      dispatch: () => createConfirmationDispatch(),
    },
    formData,
  );
}
