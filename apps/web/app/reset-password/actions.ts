"use server";

// Account-recovery completion server action (P2-008).
//
// Builds the provider port for its own request from the request-scoped,
// unprivileged server client, so nothing is shared between requests. The
// application boundary validates the whole submission before the one-time
// code is exchanged, sets the new password only through the session that
// exchange issued, ends that session, and confirms through freshly
// initialized clients over the request's updated cookie store that none
// remains. Next.js accepts this only as a POST request and applies its
// Server Action origin checks. It returns a fixed result and never
// redirects; nothing the caller sends chooses an account, a session, or a
// destination.

import {
  completeAccountRecovery,
  type CodeExchange,
  type PasswordUpdate,
  type RecoveryCompletionState,
  type RecoveryProvider,
  type RecoverySessionRead,
} from "../../src/application/account-recovery.ts";
import { SUPABASE_SERVER_SESSION_SOURCE } from "../../src/infrastructure/identity/server-session-source.ts";
import { createSupabaseServerClient } from "../../src/infrastructure/identity/supabase-server.ts";

type ServerClient = NonNullable<
  Awaited<ReturnType<typeof createSupabaseServerClient>>
>;
type ClaimsRead = Awaited<ReturnType<ServerClient["auth"]["getClaims"]>>;

const UNREADABLE: RecoverySessionRead = Object.freeze({ kind: "unreadable" });
const NO_SESSION: RecoverySessionRead = Object.freeze({ kind: "none" });
const REJECTED: CodeExchange = Object.freeze({ kind: "rejected" });
const REFUSED: PasswordUpdate = Object.freeze({ kind: "refused" });
const UNKNOWN: PasswordUpdate = Object.freeze({ kind: "unknown" });

// One verified claims read, reduced to the provider's opaque session id and
// subject. Only a successful read that finds nothing is "none"; a provider
// error or a malformed claim proves nothing. A thrown read is left to the
// application boundary, which treats it the same.
function sessionOf(read: ClaimsRead): RecoverySessionRead {
  if (read.error !== null) {
    return UNREADABLE;
  }
  if (read.data === null) {
    return NO_SESSION;
  }
  const id: unknown = read.data.claims.session_id;
  const subject: unknown = read.data.claims.sub;
  return typeof id === "string" && typeof subject === "string"
    ? Object.freeze({ kind: "session", id, subject })
    : UNREADABLE;
}

async function recoveryProvider(): Promise<RecoveryProvider | null> {
  const client = await createSupabaseServerClient();
  if (client === null) {
    return null;
  }
  return Object.freeze({
    // The client finds the code's PKCE verifier among this browser's cookies,
    // so a code opened in another browser is refused before the provider is
    // asked, and a code used before is refused by the provider. Either way no
    // session is issued.
    exchangeCode: async (code) => {
      const { data, error } = await client.auth.exchangeCodeForSession(code);
      if (error !== null) {
        return REJECTED;
      }
      const issued: unknown = data.session?.access_token;
      return Object.freeze({
        kind: "exchanged",
        userId: data.user?.id,
        sessionUserId: data.session?.user?.id,
        issuedSession: async () =>
          typeof issued === "string" && issued !== ""
            ? sessionOf(await client.auth.getClaims(issued))
            : UNREADABLE,
      });
    },
    // A refusal the provider answered changed nothing; a failed transport or
    // a server error may have.
    updatePassword: async (password) => {
      const { data, error } = await client.auth.updateUser({ password });
      if (error === null) {
        return Object.freeze({ kind: "updated", userId: data.user?.id });
      }
      return typeof error.status === "number" &&
        error.status >= 400 &&
        error.status < 500
        ? REFUSED
        : UNKNOWN;
    },
    // Ends only this browser's session; other sessions are left as they are.
    signOut: async () => {
      const { error } = await client.auth.signOut({ scope: "local" });
      return error === null;
    },
    // What this client itself holds, ahead of the request's cookies.
    heldSession: async () => sessionOf(await client.auth.getClaims()),
    // A freshly initialized client keeps nothing in memory: it reads only the
    // request's cookie store, which already carries this request's updates.
    storedSession: async () => {
      const fresh = await createSupabaseServerClient();
      return fresh === null
        ? UNREADABLE
        : sessionOf(await fresh.auth.getClaims());
    },
    session: SUPABASE_SERVER_SESSION_SOURCE,
  } satisfies RecoveryProvider);
}

// The previous state comes back from the browser and is never read.
export async function completeRecovery(
  _previous: RecoveryCompletionState,
  formData: FormData,
): Promise<RecoveryCompletionState> {
  return completeAccountRecovery(recoveryProvider, formData);
}
