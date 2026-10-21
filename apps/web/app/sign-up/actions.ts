"use server";

// Client registration server action (P2-006, P2-007).
//
// Builds the request's registration ports and hands the submitted form to
// the application boundary, which validates every field before any provider
// call and decides the fixed result. Next.js accepts this only as a POST
// request and applies its Server Action origin checks. Each request gets its
// own database-backed abuse control, but no deployed ingress contract has
// been verified to establish the client's address, so none is passed: the
// control answers unavailable and registration stays refused before any
// quota call or account creation. No request header, cookie, or form field
// is read as an address, and nothing the caller sends chooses an identity,
// role, profile, or destination.

import {
  registerClientAccount,
  type RegistrationState,
} from "../../src/application/client-registration.ts";
import {
  NO_TRUSTED_CLIENT_ADDRESS,
  createRegistrationAbuseControl,
} from "../../src/infrastructure/identity/registration-abuse-control.ts";
import {
  createConfirmationDispatch,
  createRegistrationProvisioning,
  decideQuotaRpc,
} from "../../src/infrastructure/identity/registration-provisioning.ts";

// The previous state comes back from the browser and is never read.
export async function register(
  _previous: RegistrationState,
  formData: FormData,
): Promise<RegistrationState> {
  return registerClientAccount(
    {
      abuseControl: createRegistrationAbuseControl({
        trustedClientAddress: NO_TRUSTED_CLIENT_ADDRESS,
        decideQuota: decideQuotaRpc,
      }),
      provisioning: () => createRegistrationProvisioning(),
      dispatch: () => createConfirmationDispatch(),
    },
    formData,
  );
}
