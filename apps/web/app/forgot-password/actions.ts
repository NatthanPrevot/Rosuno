"use server";

// Account-recovery request server action (P2-008).
//
// Builds the provider port for its own request from the request-scoped,
// unprivileged server client, and hands the submitted form to the
// application boundary, which reads only the email address before asking
// the provider once. The provider's recovery request is not a sign-in and
// creates no account. Through that client it stores this browser's PKCE
// verifier in the request's cookies, so only this browser can later use the
// emailed code. The link returns only to the fixed recovery address under
// the one server-configured origin; no request header, cookie, or form field
// chooses a destination. Next.js accepts this only as a POST request and
// applies its Server Action origin checks.
//
// MVP-001 S2 (PS-A4): the port also carries the request's server-only
// authentication-abuse control for recovery, which the application asks
// before the provider.

import {
  recoveryRedirectFor,
  requestAccountRecovery,
  type RecoveryRequestProvider,
  type RecoveryRequestState,
} from "../../src/application/account-recovery.ts";
import { createAuthenticationAbuseControl } from "../../src/infrastructure/identity/authentication-abuse-control.ts";
import { createSupabaseServerClient } from "../../src/infrastructure/identity/supabase-server.ts";

async function requestProvider(): Promise<RecoveryRequestProvider | null> {
  const redirectTo = recoveryRedirectFor(process.env.ROSUNO_AUTH_PUBLIC_ORIGIN);
  if (redirectTo === null) {
    return null;
  }
  const client = await createSupabaseServerClient();
  if (client === null) {
    return null;
  }
  return Object.freeze({
    // The provider's answer is deliberately not read.
    requestRecoveryEmail: async (email) => {
      await client.auth.resetPasswordForEmail(email, { redirectTo });
    },
    abuseControl: createAuthenticationAbuseControl("recovery"),
  } satisfies RecoveryRequestProvider);
}

// The previous state comes back from the browser and is never read.
export async function requestRecovery(
  _previous: RecoveryRequestState,
  formData: FormData,
): Promise<RecoveryRequestState> {
  return requestAccountRecovery(requestProvider, formData);
}
