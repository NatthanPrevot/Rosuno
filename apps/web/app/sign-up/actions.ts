"use server";

// Client registration server action (P2-006, P2-007, P2-923).
//
// Builds the request's registration ports and hands the submitted form to
// the application boundary, which validates every field before any provider
// call and decides the fixed result. Next.js accepts this only as a POST
// request and applies its Server Action origin checks. Each request gets its
// own database-backed abuse control. P2-923 (owner DECISION C): its client
// address comes only from the server-only trusted ingress, which reads the
// one header position the verified Replit edge establishes and answers no
// address for anything else; without an address the control answers
// unavailable and registration stays refused before any quota call or
// account creation. This module reads no request header, cookie, or form
// field itself, and nothing the caller sends chooses an identity, role,
// profile, destination, or the trust rule.

import {
  registerClientAccount,
  type RegistrationState,
} from "../../src/application/client-registration.ts";
import { createRegistrationAbuseControl } from "../../src/infrastructure/identity/registration-abuse-control.ts";
import {
  createConfirmationDispatch,
  createRegistrationProvisioning,
  decideQuotaRpc,
} from "../../src/infrastructure/identity/registration-provisioning.ts";
import { trustedClientAddress } from "../../src/infrastructure/identity/trusted-ingress.ts";

// The previous state comes back from the browser and is never read.
export async function register(
  _previous: RegistrationState,
  formData: FormData,
): Promise<RegistrationState> {
  return registerClientAccount(
    {
      abuseControl: createRegistrationAbuseControl({
        trustedClientAddress: await trustedClientAddress(),
        decideQuota: decideQuotaRpc,
      }),
      provisioning: () => createRegistrationProvisioning(),
      dispatch: () => createConfirmationDispatch(),
    },
    formData,
  );
}
